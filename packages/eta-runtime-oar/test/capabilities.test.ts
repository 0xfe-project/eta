/**
 * What a session on a runtime would take, before and after it opens.
 *
 * What these pin: the catalog tells a client what the installation declares (oar's
 * `sessionCapabilities`), leaving out what the runtime does not say; a listing for some runtimes
 * asks only those; and once the runtime's session is open, its own answer comes first.
 */
import type { Runtime, Session } from "@botiverse/oar";
import { createRuntimeRegistry } from "@botiverse/oar";
import { scriptedRuntime } from "@botiverse/oar/testing";
import { MemorySessionStore, SessionManager } from "@eta/server";
import { describe, expect, it } from "vitest";
import { createOarRuntimes } from "../src/index";

/** A scripted runtime under another id, with what it declares and what its sessions lack. */
function declaring(
  id: string,
  options: {
    declared?: ReturnType<NonNullable<Runtime["sessionCapabilities"]>>;
    /** Members its sessions do not have. */
    without?: readonly (keyof Session)[];
    asked?: string[];
  } = {},
): Runtime {
  const scripted = scriptedRuntime({
    id,
    turn: (turn) => {
      turn.say("done");
    },
  });
  return {
    ...scripted,
    installation: async () => {
      options.asked?.push(id);
      return await scripted.installation!();
    },
    sessionCapabilities: () => options.declared ?? {},
    session: async (installation, sessionOptions, context) => {
      const session = await scripted.session(
        installation,
        sessionOptions,
        context,
      );
      const without = new Set<PropertyKey>(options.without ?? []);
      return new Proxy(session, {
        get: (target, key) =>
          without.has(key) ? undefined : Reflect.get(target, key, target),
      });
    },
  };
}

describe("a runtime's capabilities before a session opens", () => {
  it("says what the installation declares, and leaves out what it does not", async () => {
    const runtimes = createOarRuntimes({
      registry: createRuntimeRegistry([
        declaring("claude", {
          declared: {
            steer: false,
            images: false,
            refusedSessionOptions: { mcpServers: "no MCP here" },
            manualCompaction: { kind: "unsupported", reason: "not here" },
          },
        }),
        declaring("codex"),
      ]),
    });
    const [claude, codex] = await runtimes.catalog.list(false, [
      "claude",
      "codex",
    ]);
    expect(claude?.capabilities).toEqual({
      steer: false,
      images: false,
      // With what the runtime refuses whatever its installation.
      refused: expect.objectContaining({ mcpServers: "no MCP here" }),
      compact: false,
    });
    // Nothing declared is nothing known: not a "no".
    expect(codex?.capabilities).not.toHaveProperty("steer");
    expect(codex?.capabilities).not.toHaveProperty("images");
  });

  it("asks only the runtimes a listing names", async () => {
    const asked: string[] = [];
    const runtimes = createOarRuntimes({
      registry: createRuntimeRegistry([
        declaring("claude", { asked }),
        declaring("codex", { asked }),
        declaring("opencode", { asked }),
        declaring("pi", { asked }),
      ]),
    });
    const listed = await runtimes.catalog.list(false, ["codex"]);
    expect(listed.map((info) => info.id)).toEqual(["codex"]);
    expect(asked).toEqual(["codex"]);
  });
});

describe("a session's capabilities", () => {
  it("are the declaration until the runtime's session is open, then the session's own", async () => {
    const runtimes = createOarRuntimes({
      registry: createRuntimeRegistry([
        declaring("claude", {
          declared: { steer: true, images: true },
          without: ["steer"],
        }),
      ]),
    });
    const manager = new SessionManager({
      store: new MemorySessionStore(),
      modelsFor: () => {
        throw new Error("an eta model was asked for");
      },
      runtimes,
      agentPromptFor: () => "In this conversation you are Probe.",
    });
    const managed = await manager.create({ cwd: "/work", runtime: "claude" });
    expect(await manager.runtimeCapabilities(managed.meta.id)).toMatchObject({
      steer: true,
      images: true,
    });

    managed.session.kernel.nextRun("hello");
    await managed.session.runner.run();
    // The session it opened has no way to steer, whatever was declared.
    expect(await manager.runtimeCapabilities(managed.meta.id)).toMatchObject({
      steer: false,
      images: true,
    });
    await manager.closeAll();
  });
});
