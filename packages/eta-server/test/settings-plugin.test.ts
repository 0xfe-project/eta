/**
 * The bundled `settings` plugin (S23).
 *
 * Loaded the way a loader would, checked only through the pipe's doors: an eager state target,
 * a save that merges and pushes, and a reload that actually re-reads the file.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerFrame, StateSnapshot } from "@eta/client-wire-proto";
import { Context } from "cordis";
import { afterEach, describe, expect, it } from "vitest";
import { SETTINGS_ACTIONS, settingsPlugin } from "../src/bundled/settings";
import { type Settings, SettingsStore } from "../src/settings";
import { WireService } from "../src/wire-service";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

interface Harness {
  wire: WireService;
  frames: { target?: string; frame: ServerFrame }[];
  store: SettingsStore;
  load(): Promise<() => Promise<void>>;
  call(action: string, args?: unknown): Promise<unknown>;
  settings(): Settings | undefined;
}

async function until(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs)
      throw new Error("timed out waiting for the state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function harness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "eta-settings-plugin-"));
  roots.push(root);
  const ctx = new Context();
  const wire = new WireService(ctx);
  const frames: { target?: string; frame: ServerFrame }[] = [];
  wire.attachSink((addressed) => frames.push(addressed));
  const store = new SettingsStore({ path: join(root, "settings.json") });
  return {
    wire,
    frames,
    store,
    async load() {
      const fiber = ctx.plugin(
        settingsPlugin({ store }) as never,
        undefined as never,
      );
      await fiber;
      return async () => {
        await (fiber as unknown as { dispose(): Promise<void> }).dispose();
      };
    },
    async call(action, args) {
      return await wire.dispatch(
        { op: "call", target: "settings", action, args },
        {
          reply: () => undefined,
        } as never,
      );
    },
    settings() {
      const snapshot = wire.snapshot("settings") as StateSnapshot | undefined;
      return (snapshot?.sections.settings as Settings | undefined) ?? undefined;
    },
  };
}

describe("the settings target", () => {
  it("registers its actions and an eager state target", async () => {
    const h = await harness();
    const unload = await h.load();
    expect(
      h.wire
        .descriptors()
        .map((descriptor) => descriptor.name)
        .sort(),
    ).toEqual(
      [...SETTINGS_ACTIONS].map((action) => `settings.${action}`).sort(),
    );
    expect(h.wire.registry.eagerTargets()).toContain("settings");
    await until(() => h.settings() !== undefined);
    expect(h.settings()).toEqual({});
    await unload();
    expect(h.wire.descriptors()).toEqual([]);
    expect(h.wire.registry.hasState("settings")).toBe(false);
  });

  it("merges a save, and pushes what the file now holds", async () => {
    const h = await harness();
    const unload = await h.load();
    await until(() => h.settings() !== undefined);
    h.wire.subscribe(1, "settings");
    h.frames.length = 0;

    await h.call("save", { cwd: "/work/eta", thinkingLevel: "high" });
    expect(h.settings()).toEqual({ cwd: "/work/eta", thinkingLevel: "high" });
    expect(
      h.frames.some(
        (entry) => entry.target === "settings" && entry.frame.type === "state",
      ),
    ).toBe(true);
    // A second patch keeps what the first one set.
    await h.call("save", { persona: "Executor" });
    expect(h.settings()).toMatchObject({
      cwd: "/work/eta",
      thinkingLevel: "high",
      persona: "Executor",
    });
    await unload();
  });

  it("re-reads the file on reload, so a hand edit is visible", async () => {
    const h = await harness();
    const unload = await h.load();
    await until(() => h.settings() !== undefined);
    await h.call("save", { cwd: "/from/the/page" });
    await writeFile(
      h.store.path,
      JSON.stringify({ cwd: "/edited/by/hand", thinkingLevel: "low" }),
      "utf8",
    );
    // Without a reload the plugin still answers with what it last read — which is why reload
    // exists at all.
    expect(h.settings()?.cwd).toBe("/from/the/page");
    await h.call("reload", {});
    expect(h.settings()).toMatchObject({
      cwd: "/edited/by/hand",
      thinkingLevel: "low",
    });
    await unload();
  });
});
