// The agent runtime: one container per agent, always running, its state on
// the agent's volume (/agent). On start it installs the image's plugins,
// starts Codex's app-server, resumes the agent's thread (or starts one: there
// is none before the first turn), serves the control API and reports itself
// started. Docker restarts it when it exits.

import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import process from "node:process";
import { serve } from "@hono/node-server";
import { jetstream } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import { Agent } from "./agent.ts";
import { AppServer } from "./appserver.ts";
import { keepGitHubLoggedIn } from "./github.ts";
import { Outbox } from "./outbox.ts";
import { installPlugins } from "./plugins.ts";
import { controlAPI } from "./server.ts";
import { codexArgs, loadSettings } from "./settings.ts";
import { openThread, ResumeFailed } from "./thread.ts";

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
  let codex: AppServer | undefined;
  let stopping = false;
  const exit = async (code: number): Promise<never> => {
    stopping = true;
    codex?.close();
    await outbox.drain(7000);
    await nats.drain().catch(() => {});
    process.exit(code);
  };

  let thread: { threadId: string; resumed: boolean };
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
    // Codex and the agent's commands never see the controller's token.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CODEX_HOME: s.codexHome,
      AXP_WORKSPACE_DIR: s.workspace,
    };
    delete env.AXP_CONTROL_TOKEN;
    codex = await AppServer.start("codex", codexArgs(s), env, s.workspace);
    try {
      thread = await openThread(codex, s);
    } catch (error) {
      throw error instanceof ResumeFailed
        ? new StartFailed("RECOVERY_RESUME_FAILED", error)
        : error;
    }
  } catch (error) {
    console.error("Runtime not ready", error);
    outbox.emit("runtime.failed", {
      code: error instanceof StartFailed ? error.code : "START_FAILED",
    });
    return exit(1);
  }

  const agent = new Agent(codex, thread.threadId, outbox.emit);
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
    `${thread.resumed ? "Resumed" : "Started"} thread ${thread.threadId}; control API on :${s.port}`,
  );
  outbox.emit("runtime.started", {
    thread_id: thread.threadId,
    resumed: thread.resumed,
  });

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
