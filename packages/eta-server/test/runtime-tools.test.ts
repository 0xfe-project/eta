/**
 * The host's tools in a session an external runtime answers in.
 *
 * The runtime has its own files, shell and memory, so the session gets none of eta's. But the
 * host's own tools (publish_artifact, which packs a directory) still run on eta's side, through
 * the delegate's `executeTool`, and they find the session's directory through their own cwd.
 * What these pin: such a tool is reachable from the runtime, handed the call it asked for, and
 * the session still has no read/write/edit/bash.
 */
import type { KernelTool, RunDelegate, ToolCallInfo } from "@eta/core";
import type { SessionRuntimes } from "../src/runtimes";
import { fakeModels } from "@eta/core/testing";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../src/manager";
import { MemorySessionStore } from "../src/memory-store";

const userMsg = (text: string) => ({
  role: "user" as const,
  content: [{ type: "text" as const, text }],
  timestamp: 0,
});

async function until(
  predicate: () => boolean,
  timeoutMs = 3_000,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs)
      throw new Error("timed out waiting for the run");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A host tool that records the call it was given. */
function probe(seen: unknown[]): KernelTool {
  return {
    name: "probe",
    description: "the probe tool",
    parameters: { type: "object", properties: {} },
    execute: (_args: unknown, call: ToolCallInfo) => {
      seen.push(call);
      return { content: [{ type: "text", text: "probed" }] };
    },
  } as KernelTool;
}

/** A runtime whose every run calls the host's `probe` tool once, as an MCP call would. */
function runtimes(): { runtimes: SessionRuntimes; results: unknown[] } {
  const results: unknown[] = [];
  const delegate: RunDelegate = {
    run: async (context) => {
      results.push(
        await context.executeTool("probe", {}, { toolCallId: "mcp-1" }),
      );
      return { status: "completed" };
    },
  };
  return {
    runtimes: {
      open: () => ({
        models: fakeModels([]) as never,
        delegate,
        dispose: async () => undefined,
      }),
    } as unknown as SessionRuntimes,
    results,
  };
}

describe("a session on an external runtime", () => {
  it("runs the host's tools, and installs none of eta's file tools", async () => {
    const seen: unknown[] = [];
    const { runtimes: hosted, results } = runtimes();
    const sessions = new SessionManager({
      store: new MemorySessionStore(),
      modelsFor: () => fakeModels([]) as never,
      sessionTools: () => [probe(seen)],
      runtimes: hosted,
    });
    const { session } = await sessions.create({
      cwd: "/work",
      runtime: "claude",
    });
    for (const name of ["read", "write", "edit", "bash"])
      expect(session.kernel.tools.get(name)).toBeUndefined();
    expect(session.kernel.tools.get("probe")).toBeDefined();

    session.kernel.inject(userMsg("publish it"));
    await until(() => results.length === 1);
    await until(() => !session.runner.running);
    session.kernel.inject(userMsg("again"));
    await until(() => results.length === 2);

    expect(seen).toHaveLength(2);
    expect(JSON.stringify(results[0])).toContain("probed");
    await sessions.closeAll();
  });

  it("without a host tool table, the session has neither eta's tools nor the host's", async () => {
    const { runtimes: hosted, results } = runtimes();
    const sessions = new SessionManager({
      store: new MemorySessionStore(),
      modelsFor: () => fakeModels([]) as never,
      runtimes: hosted,
    });
    const { session } = await sessions.create({
      cwd: "/work",
      runtime: "claude",
    });
    expect(session.kernel.tools.get("bash")).toBeUndefined();
    expect(session.kernel.tools.get("probe")).toBeUndefined();
    session.kernel.inject(userMsg("publish it"));
    await until(() => results.length === 1);
    // The runtime called a tool nobody registered: it is told so, and the session carries on.
    expect(JSON.stringify(results[0])).toContain("unknown tool");
    await sessions.closeAll();
  });
});
