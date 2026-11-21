/**
 * Every runtime eta offers, under its own id, on oar's scripted runtime: the paths that differ by
 * runtime (how a host tool is spelled back, whether a system prompt is taken) meet the same
 * session semantics as a real one, for a runtime that is not installed or signed in here.
 */
import type { ScriptedTurn } from "@botiverse/oar/testing";
import type { AgentMessage, KernelTool } from "@eta/core";
import type { ManagedSession } from "@eta/server";
import { createRuntimeRegistry } from "@botiverse/oar";
import { scriptedRuntime } from "@botiverse/oar/testing";
import { MemorySessionStore, SessionManager } from "@eta/server";
import { describe, expect, it } from "vitest";
import { createOarRuntimes, RUNTIME_IDS } from "../src/index";

const tick = async (ms = 20) =>
  await new Promise((resolve) => setTimeout(resolve, ms));

const textOf = (message: AgentMessage): string =>
  "content" in message && Array.isArray(message.content)
    ? message.content
        .map((block) =>
          block.type === "text"
            ? block.text
            : block.type === "toolCall"
              ? `[${block.name}]`
              : "",
        )
        .join("")
    : "";

/** How each runtime names a host tool in its events; Codex names it only in its native frame. */
const SPELLED: Record<string, string> = {
  claude: "mcp__eta__echo",
  pi: "mcp__eta__echo",
  opencode: "eta_echo",
};

const echo = {
  name: "echo",
  description: "echo",
  parameters: { type: "object", properties: {} },
  execute: () => ({ content: [{ type: "text", text: "echoed" }] }),
} as unknown as KernelTool;

async function turnOf(turn: ScriptedTurn, id: string): Promise<void> {
  if (turn.input.includes("wait")) {
    await new Promise((resolve) =>
      turn.signal.addEventListener("abort", resolve, { once: true }),
    );
    return;
  }
  if (turn.input.includes("steer me")) {
    for (let i = 0; i < 100 && turn.steered.length === 0; i++) await tick(10);
    turn.say(`heard ${turn.steered.join(",")}`);
    return;
  }
  if (turn.input.includes("tool") && SPELLED[id] !== undefined) {
    await turn.tool(SPELLED[id], "{}", () => "echoed");
    turn.say("used it");
    return;
  }
  turn.say(`ok ${turn.input.split("\n").at(-1)}`);
}

async function run(managed: ManagedSession, prompt: string) {
  managed.session.kernel.nextRun(prompt);
  return await managed.session.runner.run();
}

describe.each(RUNTIME_IDS)("%s, scripted", (id) => {
  it("replies, calls a host tool, steers, stops and resumes", async () => {
    const turns: ScriptedTurn[] = [];
    const runtime = scriptedRuntime({
      id,
      turn: async (turn) => {
        turns.push(turn);
        await turnOf(turn, id);
      },
    });
    const manager = new SessionManager({
      store: new MemorySessionStore(),
      modelsFor: () => {
        throw new Error("an eta model was asked for");
      },
      runtimes: createOarRuntimes({
        registry: createRuntimeRegistry([runtime]),
      }),
      agentPromptFor: () => "You are Probe.",
      sessionTools: () => [echo],
    });
    const created = await manager.create({ cwd: "/work", runtime: id });
    const transcript = (managed: ManagedSession) =>
      managed.session.journaling
        .transcript()
        .map((message) => `${message.role}:${textOf(message)}`);

    expect((await run(created, "hello")).status).toBe("completed");
    expect(turns[0]!.options.appendSystemPrompt).toContain("You are Probe.");
    expect(turns[0]!.options.mcpServers).toHaveLength(1);

    if (SPELLED[id] !== undefined) {
      expect((await run(created, "use the tool")).status).toBe("completed");
      // The host's tool is told back under the host's name, whatever the runtime called it.
      expect(transcript(created)).toContain("assistant:[echo]");
    }

    const steering = run(created, "steer me");
    await tick(50);
    created.session.kernel.steer("now");
    expect((await steering).status).toBe("completed");
    expect(transcript(created).at(-1)).toBe("assistant:heard now");

    const waiting = run(created, "wait");
    await tick(50);
    created.session.runner.abort();
    expect((await waiting).status).toBe("aborted");
    expect((await run(created, "after the stop")).status).toBe("completed");

    const native = created.meta.runtimeSession;
    expect(native).toBeDefined();
    await manager.close(created.meta.id);
    const reopened = (await manager.session(created.meta.id))!;
    expect((await run(reopened, "again")).status).toBe("completed");
    expect(turns.at(-1)!.options.resume).toBe(native);
    expect(transcript(reopened).at(-1)).toBe("assistant:ok again");
    await manager.closeAll();
  });
});
