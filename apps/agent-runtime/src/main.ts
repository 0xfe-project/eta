// The agent runtime: one container per agent, always running, its state on
// the agent's volume (/agent). On start it installs the image's plugins,
// resumes the agent's Codex thread (or starts one: there is none before the
// first turn), serves the control API and reports itself started. Docker
// restarts it when it exits.

import type { Session, SessionOptions } from "@botiverse/oar";
import type { Settings } from "./settings.ts";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import process from "node:process";
import { codexRuntime, SessionNotFoundError } from "@botiverse/oar";
import { serve } from "@hono/node-server";
import { jetstream } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import { Agent } from "./agent.ts";
import { keepGitHubLoggedIn } from "./github.ts";
import { Outbox } from "./outbox.ts";
import { installPlugins } from "./plugins.ts";
import { controlAPI } from "./server.ts";
import { codexArgs, loadSettings } from "./settings.ts";
import { latestThread } from "./thread.ts";

function info(...parts: unknown[]): void {
  process.stdout.write(`${parts.join(" ")}\n`);
}

class StartFailed extends Error {
  constructor(
    readonly code: string,
    cause: unknown,
  ) {
    super(
      `${code}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}

async function openSession(
  s: Settings,
): Promise<{ session: Session; resumed: boolean }> {
  const installation = await codexRuntime.installation?.();
  if (installation?.kind !== "available") {
    throw new StartFailed("CODEX_NOT_INSTALLED", JSON.stringify(installation));
  }
  const options: SessionOptions = {
    cwd: s.workspace,
    model: s.model,
    appendSystemPrompt: s.instructions || undefined,
    launchArgs: codexArgs(s),
    // Codex and the agent's commands never see the controller's token.
    env: {
      CODEX_HOME: s.codexHome,
      AXP_WORKSPACE_DIR: s.workspace,
      AXP_CONTROL_TOKEN: null,
    },
  };
  const thread = await latestThread(s.codexHome, s.workspace);
  if (thread !== undefined) {
    try {
      return {
        session: await codexRuntime.session(installation, {
          ...options,
          resume: thread,
        }),
        resumed: true,
      };
    } catch (error) {
      if (!(error instanceof SessionNotFoundError)) {
        throw new StartFailed("RECOVERY_RESUME_FAILED", error);
      }
    }
  }
  return {
    session: await codexRuntime.session(installation, options),
    resumed: false,
  };
}

async function main(): Promise<void> {
  const s = loadSettings();
  const nats = await connect({
    servers: s.natsUrl,
    name: `agent-${s.agentId}`,
    maxReconnectAttempts: -1,
    waitOnFirstConnect: true,
  });
  const js = jetstream(nats);
  const outbox = new Outbox(
    async (subject, data, msgID) =>
      void (await js.publish(subject, data, { msgID, timeout: 5000 })),
    `axp.agent.${s.agentId}.events`,
    randomUUID(),
  );
  let session: Session | undefined;
  let stopping = false;
  const exit = async (code: number): Promise<never> => {
    stopping = true;
    await session?.dispose();
    await outbox.drain(7000);
    await nats.drain().catch(() => {});
    process.exit(code);
  };

  let resumed = false;
  try {
    await mkdir(s.workspace, { recursive: true });
    await mkdir(s.codexHome, { recursive: true });
    try {
      const plugins = await installPlugins(s);
      info("Installed plugins:", plugins.join(", ") || "none");
    } catch (error) {
      throw new StartFailed("PLUGIN_INSTALL_FAILED", error);
    }
    keepGitHubLoggedIn(s);
    ({ session, resumed } = await openSession(s));
  } catch (error) {
    console.error("Runtime not ready", error);
    outbox.emit("runtime.failed", {
      code: error instanceof StartFailed ? error.code : "START_FAILED",
    });
    return exit(1);
  }

  const agent = new Agent(session, outbox.emit);
  agent.onExit = (code) => {
    if (!stopping) {
      console.error("Codex exited", code);
      void exit(1);
    }
  };
  const server = serve({
    fetch: controlAPI(agent, s.controlToken, outbox.bootId).fetch,
    hostname: "0.0.0.0",
    port: s.port,
  });
  info(
    `${resumed ? "Resumed" : "Started"} thread ${session.id}; control API on :${s.port}`,
  );
  outbox.emit("runtime.started", { thread_id: session.id, resumed });

  // Docker stops containers with SIGTERM, then kills them after 10 seconds.
  const stop = (): void => {
    if (stopping) {
      return;
    }
    server.close();
    void exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
