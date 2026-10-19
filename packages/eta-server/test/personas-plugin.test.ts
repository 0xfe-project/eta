/**
 * The bundled `personas` plugin (S24 + S15b).
 *
 * Loaded the way a loader would, checked through the pipe: the cards that apply here as an eager
 * state target, a reload that re-reads, and `set` — which is the session-side half, and the one
 * with rules worth stating. An id nobody has is *refused*, not quietly turned into the fallback:
 * the user asked for a card, and a different one is not what they asked for.
 */

import type { ServerFrame, StateSnapshot } from "@eta/client-wire-proto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assistantMessage, fakeModels } from "@eta/core/testing";
import { Context } from "cordis";
import { afterEach, describe, expect, it } from "vitest";
import { PERSONA_ACTIONS, personasPlugin } from "../src/bundled/personas";
import { SessionsService } from "../src/bundled/sessions";
import { SessionManager } from "../src/manager";
import { MemorySessionStore } from "../src/memory-store";
import { WireService } from "../src/wire-service";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function until(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function card(
  directory: string,
  id: string,
  body: string,
): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${id}.persona.md`), body, "utf8");
}

interface Harness {
  wire: WireService;
  manager: SessionManager;
  frames: { target?: string; frame: ServerFrame }[];
  home: string;
  project: string;
  load: () => Promise<() => Promise<void>>;
  cards: () => { id: string; description: string }[];
}

async function harness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "eta-personas-plugin-"));
  roots.push(root);
  const home = join(root, "home");
  const project = join(root, "project");
  await mkdir(home, { recursive: true });
  await mkdir(project, { recursive: true });
  const ctx = new Context();
  const wire = new WireService(ctx);
  const frames: { target?: string; frame: ServerFrame }[] = [];
  wire.attachSink((addressed) => frames.push(addressed));
  const manager = new SessionManager({
    store: new MemorySessionStore(),
    modelsFor: () => fakeModels([assistantMessage()]) as never,
    personasFor: async () => [],
  });
  // Registers the `sessions` target on the context; nothing reads it back.
  void new SessionsService(ctx, { manager, wire });
  return {
    wire,
    manager,
    frames,
    home,
    project,
    async load() {
      const fiber = ctx.plugin(
        personasPlugin({ manager, home }) as never,
        undefined as never,
      );
      await fiber;
      return async () => {
        await (fiber as unknown as { dispose: () => Promise<void> }).dispose();
      };
    },
    cards() {
      const snapshot = wire.snapshot("personas") as StateSnapshot | undefined;
      return (
        (snapshot?.sections.cards as { id: string; description: string }[]) ??
        []
      );
    },
  };
}

describe("the personas target", () => {
  it("registers its actions and an eager state target", async () => {
    const h = await harness();
    const unload = await h.load();
    expect(
      h.wire
        .descriptors()
        .map((descriptor) => descriptor.name)
        .sort(),
    ).toEqual(
      [...PERSONA_ACTIONS].map((action) => `personas.${action}`).sort(),
    );
    expect(h.wire.registry.eagerTargets()).toContain("personas");
    await unload();
    expect(h.wire.descriptors()).toEqual([]);
  });

  it("publishes the cards that apply — built-ins included — and re-reads on reload", async () => {
    const h = await harness();
    const unload = await h.load();
    await card(
      join(h.home, ".eta", "persona"),
      "Executor",
      "# Executor\nShip the thing.\n",
    );
    const reloaded = (await h.wire.dispatch(
      {
        op: "call",
        target: "personas",
        action: "reload",
        args: { cwd: h.project },
      },
      { reply: () => undefined } as never,
    )) as {
      result: { cards: { id: string; custom: boolean; description: string }[] };
    };
    expect(reloaded.result.cards.map((entry) => entry.id).sort()).toEqual([
      "Artist",
      "Executor",
      "Insighter",
      "Thinker",
    ]);
    // The state section says the same thing, because it is the same read. The written
    // card shadows the built-in by name and is marked as somebody's own.
    await until(() => h.cards().length === 4);
    expect(h.cards()).toContainEqual({
      id: "Executor",
      name: "Executor",
      description: "Executor",
      custom: true,
    });
    await unload();
  });
});

describe("putting a session on a card", () => {
  it("switches the card, writes the choice to the session's row, and pushes", async () => {
    const h = await harness();
    const unload = await h.load();
    await card(
      join(h.home, ".eta", "persona"),
      "Executor",
      "# Executor\nShip the thing.\n",
    );
    const created = await h.manager.create({
      cwd: h.project,
      persona: undefined,
    });
    h.wire.subscribe(1, "personas");
    h.frames.length = 0;

    const set = (await h.wire.dispatch(
      {
        op: "call",
        target: "personas",
        action: "set",
        args: { session: created.meta.id, persona: "Executor" },
      },
      { reply: () => undefined } as never,
    )) as { result: { session: string; persona: string } };
    expect(set.result).toEqual({
      session: created.meta.id,
      persona: "Executor",
    });
    // The session is on it, and its row says so — a restart comes back on the same card.
    expect(created.session.kernel.inspect().activePersonaNames).toContain(
      "Executor",
    );
    const row = (await h.manager.list()).find(
      (listing) => listing.id === created.meta.id,
    );
    expect(row?.ok === true ? row.meta.persona : undefined).toBe("Executor");
    // The card list itself did not move (the user picked an existing card), so no frame is owed
    // for it — which is the state sender's whole rule. What moved is the session, and that is
    // what a client watching it sees.
    expect(h.frames).toEqual([]);
    await h.manager.closeAll();
    await unload();
  });

  it("refuses an id nobody has, and refuses a session that is not there", async () => {
    const h = await harness();
    const unload = await h.load();
    await card(
      join(h.home, ".eta", "persona"),
      "Executor",
      "# Executor\nShip.\n",
    );
    const created = await h.manager.create({ cwd: h.project });
    const set = (args: unknown): Promise<unknown> =>
      h.wire.dispatch({ op: "call", target: "personas", action: "set", args }, {
        reply: () => undefined,
      } as never);
    await expect(
      set({ session: created.meta.id, persona: "Ghost" }),
    ).rejects.toThrow(/no such persona/);
    await expect(set({ session: "nope", persona: "Executor" })).rejects.toThrow(
      /no such session/,
    );
    await expect(set({ session: created.meta.id })).rejects.toThrow(
      /needs a session and a persona/,
    );
    // The refused call changed nothing.
    expect(created.session.kernel.inspect().activePersonaNames).toEqual([]);
    await h.manager.closeAll();
    await unload();
  });
});
