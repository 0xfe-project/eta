/**
 * The host's tools in a session an external runtime answers in.
 *
 * The runtime has its own files, shell and memory, so the session gets none of eta's. But the
 * host's own tools (publish_artifact, which packs a directory) still run on eta's side, through
 * the delegate's `executeTool`, and they need the environment an eta session would give them.
 * What these pin: such a tool is handed the host's environment for the session's directory, and
 * the session still has no read/write/edit/bash.
 */
import type { KernelTool, RunDelegate, ToolCallInfo } from "@eta/core";
import type { ExecutionEnv } from "@eta/harness";
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

/** A host tool that records the context its call was given. */
function probe(seen: unknown[]): KernelTool {
  return {
    name: "probe",
    description: "the probe tool",
    parameters: { type: "object", properties: {} },
    execute: (_args: unknown, call: ToolCallInfo) => {
      seen.push(call.toolContext);
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
    results,
    runtimes: {
      open: () => ({
        models: fakeModels([]) as never,
        delegate,
        dispose: async () => undefined,
      }),
    },
  };
}

describe("a session on an external runtime", () => {
  it("hands the host's tools the session's environment, and installs none of eta's file tools", async () => {
    const env = { cwd: "/work" } as unknown as ExecutionEnv;
    const asked: string[] = [];
    const seen: unknown[] = [];
    const { runtimes: hosted, results } = runtimes();
    const sessions = new SessionManager({
      store: new MemorySessionStore(),
      modelsFor: () => fakeModels([]) as never,
      envFor: (meta) => {
        asked.push(meta.cwd);
        return { env };
      },
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
    // Nothing is made until a tool asks for it.
    expect(asked).toEqual([]);

    session.kernel.inject(userMsg("publish it"));
    await until(() => results.length === 1);
    await until(() => !session.runner.running);
    session.kernel.inject(userMsg("again"));
    await until(() => results.length === 2);

    expect(seen).toHaveLength(2);
    expect((seen[0] as { env?: unknown }).env).toBe(env);
    expect((seen[1] as { env?: unknown }).env).toBe(env);
    // One environment for the session, not one per call.
    expect(asked).toEqual(["/work"]);
    expect(JSON.stringify(results[0])).toContain("probed");
    await sessions.closeAll();
  });

  it("without a host environment, the tools get a context with none, and still no file tools", async () => {
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
    expect(session.kernel.tools.get("bash")).toBeUndefined();
    session.kernel.inject(userMsg("publish it"));
    await until(() => results.length === 1);
    expect((seen[0] as { env?: unknown } | undefined)?.env).toBeUndefined();
    await sessions.closeAll();
  });

  it("leaves an eta session as it was: the file tools, and the same environment", async () => {
    const env = { cwd: "/work" } as unknown as ExecutionEnv;
    const sessions = new SessionManager({
      store: new MemorySessionStore(),
      modelsFor: () => fakeModels([]) as never,
      envFor: () => ({ env }),
    });
    const { session } = await sessions.create({ cwd: "/work" });
    for (const name of ["read", "write", "edit", "bash"])
      expect(session.kernel.tools.get(name)).toBeDefined();
    await sessions.closeAll();
  });
});
