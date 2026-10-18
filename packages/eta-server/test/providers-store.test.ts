/**
 * The providers config store (S19).
 *
 * The file is shared: a user edits it in an editor, a settings page edits it over the wire, and
 * both can be doing so at once. These tests are about the three rules that make that survivable —
 * the revision a write carries, the atomicity of the write, and the refusal to overwrite a file
 * that does not parse — plus the watch that tells a host the file changed.
 */
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderConfigStore, revisionOf } from "../src/providers/store";

const roots: string[] = [];

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eta-providers-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const provider = (id: string, models = ["m1"]) => ({
  id,
  kind: "openai-compatible" as const,
  baseUrl: `https://${id}.example/v1`,
  models: models.map((model) => ({ id: model })),
});

describe("a config that is not there", () => {
  it("reads as no providers, and says so in the revision", async () => {
    const root = await scratch();
    const store = new ProviderConfigStore({ path: join(root, "config.json") });
    const view = await store.view();
    expect(view.providers).toEqual([]);
    expect(view.network).toEqual({ mode: "system" });
    // The revision of "no file" is the revision of empty content, which is what a first write
    // carries: creating the file is a write like any other.
    expect(view.revision).toBe(revisionOf(""));
  });
});

describe("writes", () => {
  it("adds a provider, and the file it leaves behind is the config", async () => {
    const root = await scratch();
    const path = join(root, "config.json");
    const store = new ProviderConfigStore({ path });
    const saved = await store.save({
      revision: revisionOf(""),
      provider: provider("local", ["a", "b"]),
    });
    expect(saved.providers.map((entry) => entry.id)).toEqual(["local"]);
    expect(saved.providers[0]?.models.map((model) => model.id)).toEqual([
      "a",
      "b",
    ]);

    // The file is the truth: a fresh store over the same path sees the same thing.
    const reread = await new ProviderConfigStore({ path }).view();
    expect(reread.providers[0]?.id).toBe("local");
    expect(reread.revision).toBe(saved.revision);
    // And it is written at 0600: an API key must never exist with looser permissions.
    const mode = (await stat(path)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("refuses a write whose revision is stale, rather than reverting the other edit", async () => {
    const root = await scratch();
    const path = join(root, "config.json");
    const store = new ProviderConfigStore({ path });
    const first = await store.save({
      revision: revisionOf(""),
      provider: provider("a"),
    });
    // Somebody else saved in the meantime; this caller still holds the old revision.
    await store.save({ revision: first.revision, provider: provider("b") });
    await expect(
      store.save({ revision: first.revision, provider: provider("c") }),
    ).rejects.toThrow(/config_changed/);
    // Neither write was lost: both a and b are there, and c is not.
    const view = await store.view();
    expect(view.providers.map((entry) => entry.id).sort()).toEqual(["a", "b"]);
  });

  it("catches an external editor that changed the file while a write was prepared", async () => {
    const root = await scratch();
    const path = join(root, "config.json");
    const store = new ProviderConfigStore({ path });
    const view = await store.save({
      revision: revisionOf(""),
      provider: provider("a"),
    });
    // The file changes under the store's feet, between the read and the rename.
    await writeFile(
      path,
      `${JSON.stringify({ providers: [{ ...provider("external"), models: [{ id: "m1" }] }] })}\n`,
    );
    await expect(
      store.save({ revision: view.revision, provider: provider("b") }),
    ).rejects.toThrow(/config_changed/);
  });

  it("keeps a saved API key when the form did not send one, and clears it on an explicit null", async () => {
    const root = await scratch();
    const path = join(root, "config.json");
    const store = new ProviderConfigStore({ path });
    const saved = await store.save({
      revision: revisionOf(""),
      provider: { ...provider("a"), apiKey: "sk-secret" },
    });
    expect(saved.providers[0]?.hasApiKey).toBe(true);
    // The view never carries the key itself.
    expect(JSON.stringify(saved)).not.toContain("sk-secret");

    // A rename that does not mention the key keeps it.
    const renamed = await store.save({
      revision: saved.revision,
      provider: { ...provider("a"), name: "renamed" },
    });
    expect(renamed.providers[0]?.hasApiKey).toBe(true);
    expect(renamed.providers[0]?.name).toBe("renamed");

    // An explicit null clears it.
    const cleared = await store.save({
      revision: renamed.revision,
      provider: { ...provider("a"), apiKey: null },
    });
    expect(cleared.providers[0]?.hasApiKey).toBe(false);
  });

  it("deletes a provider, and forgets a default that pointed at it", async () => {
    const root = await scratch();
    const path = join(root, "config.json");
    const store = new ProviderConfigStore({ path });
    const saved = await store.save({
      revision: revisionOf(""),
      provider: provider("a"),
    });
    const withDefault = await store.setDefault("a:m1", saved.revision);
    expect(withDefault.defaultModel).toBe("a:m1");
    const removed = await store.delete("a", withDefault.revision);
    expect(removed.providers).toEqual([]);
    expect(removed.defaultModel).toBeUndefined();
  });

  it("refuses a default that names no configured model", async () => {
    const root = await scratch();
    const store = new ProviderConfigStore({ path: join(root, "config.json") });
    const saved = await store.save({
      revision: revisionOf(""),
      provider: provider("a"),
    });
    await expect(store.setDefault("a:nope", saved.revision)).rejects.toThrow(
      /invalid_default_model/,
    );
  });

  it("serialises concurrent writes, so both land", async () => {
    const root = await scratch();
    const path = join(root, "config.json");
    const store = new ProviderConfigStore({ path });
    const first = await store.save({
      revision: revisionOf(""),
      provider: provider("a"),
    });
    // Two writes prepared against the same revision: one wins, the other is refused — but the
    // store never interleaves them, so the file is always a complete config.
    const results = await Promise.allSettled([
      store.save({ revision: first.revision, provider: provider("b") }),
      store.save({ revision: first.revision, provider: provider("c") }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const view = await store.view();
    // Exactly one of b and c landed, and a was never lost: a refused write is a refusal, not
    // a partial one.
    expect(view.providers.length).toBe(2);
    expect(view.providers.map((entry) => entry.id)).toContain("a");
    expect(
      view.providers.filter((entry) => entry.id === "b" || entry.id === "c"),
    ).toHaveLength(1);
  });
});

describe("a config that will not parse", () => {
  it("is an error, not an empty config", async () => {
    const root = await scratch();
    const path = join(root, "config.json");
    await writeFile(path, "{ this is not json");
    const store = new ProviderConfigStore({ path });
    await expect(store.view()).rejects.toThrow(/invalid_saved_config/);
    // And a write against it is refused rather than replacing what the user had.
    await expect(
      store.save({ revision: revisionOf(""), provider: provider("a") }),
    ).rejects.toThrow(/invalid_saved_config/);
    expect(await readFile(path, "utf8")).toBe("{ this is not json");
  });

  it("is an error when a provider is missing the fields the server needs", async () => {
    const root = await scratch();
    const path = join(root, "config.json");
    await writeFile(
      path,
      JSON.stringify({ providers: [{ id: "a", models: [] }] }),
    );
    await expect(new ProviderConfigStore({ path }).view()).rejects.toThrow(
      /invalid_saved_config/,
    );
  });
});

describe("watching the file", () => {
  it("notices an external change and hands back the new view", async () => {
    const root = await scratch();
    const path = join(root, "config.json");
    const changes: string[][] = [];
    const store = new ProviderConfigStore({ path, watchIntervalMs: 5 });
    const saved = await store.save({
      revision: revisionOf(""),
      provider: provider("a"),
    });
    store.watch((view) =>
      changes.push(view.providers.map((provider) => provider.id)),
    );
    // An editor (or another process) writes the file.
    await writeFile(
      path,
      `${JSON.stringify({ providers: [provider("a"), provider("external")] }, null, 2)}\n`,
    );
    const deadline = Date.now() + 2_000;
    while (changes.length === 0 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    store.stop();
    expect(changes).toEqual([["a", "external"]]);
    // The revision the store had is not the one the file has any more.
    expect((await store.view()).revision).not.toBe(saved.revision);
  });

  it("says nothing when nothing changed", async () => {
    const root = await scratch();
    const path = join(root, "config.json");
    const changes: unknown[] = [];
    const store = new ProviderConfigStore({ path, watchIntervalMs: 5 });
    await store.save({ revision: revisionOf(""), provider: provider("a") });
    store.watch((view) => changes.push(view));
    await new Promise((resolve) => setTimeout(resolve, 40));
    store.stop();
    expect(changes).toEqual([]);
  });
});

describe("the proxy a settings page writes", () => {
  it("normalises a URL, and refuses one that would put a password in the file", async () => {
    const root = await scratch();
    const path = join(root, "config.json");
    const store = new ProviderConfigStore({ path });
    const view = await store.setNetwork(
      { mode: "manual", proxyUrl: " http://localhost:1082 " },
      revisionOf(""),
    );
    // Stored as the URL a client would parse, not as the string that was typed: trimmed, and in
    // the canonical form `URL` produces.
    expect(view.network?.proxyUrl).toBe("http://localhost:1082/");
    expect(JSON.parse(await readFile(path, "utf8")).network.proxyUrl).toBe(
      "http://localhost:1082/",
    );

    // Credentials belong in the environment, not in a file the UI renders back.
    await expect(
      store.setNetwork(
        { mode: "manual", proxyUrl: "http://user:secret@localhost:1082" },
        view.revision,
      ),
    ).rejects.toThrow(/invalid_network/);
    // And a string that is not a URL is refused now, not discovered later. A scheme-less
    // `host:port` is in this group on purpose: `URL` reads `localhost:1082` as the scheme
    // `localhost:`, and inventing one is how a proxy ends up pointing somewhere unexpected.
    await expect(
      store.setNetwork(
        { mode: "manual", proxyUrl: "not a url" },
        view.revision,
      ),
    ).rejects.toThrow(/invalid_network/);
    await expect(
      store.setNetwork(
        { mode: "manual", proxyUrl: "localhost:1082" },
        view.revision,
      ),
    ).rejects.toThrow(/invalid_network/);
    await expect(
      store.setNetwork(
        { mode: "manual", proxyUrl: "ftp://x:1" },
        view.revision,
      ),
    ).rejects.toThrow(/invalid_network/);
    // The refusal changed nothing.
    expect((await store.view()).network?.proxyUrl).toBe(
      "http://localhost:1082/",
    );
  });
});
