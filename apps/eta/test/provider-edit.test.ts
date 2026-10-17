import type { Host } from "../src/host";
/**
 * Editing providers through the host (FRONTEND_REFACTOR.md §8, P11).
 *
 * The file is the source of truth, and it is also something a person edits by hand, so the tests
 * are about what a good editor on top of a shared file has to do: never hand a key back, leave
 * fields it does not know alone, and say that a change needs a restart because this process built
 * its providers at startup.
 */
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assembleHost } from "../src/host";

const roots: string[] = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const CONFIG = {
  // A field this build knows nothing about: an edit must not erase it.
  somethingNewer: { keep: true },
  providers: [
    {
      id: "local",
      kind: "openai-compatible",
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: "sk-secret-value",
      models: [{ id: "m1" }],
    },
  ],
};

async function start(): Promise<{ host: Host; configPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "eta-providers-"));
  roots.push(root);
  const configPath = join(root, "config.json");
  await writeFile(configPath, JSON.stringify(CONFIG), "utf8");
  const host = await assembleHost({
    dataDir: root,
    port: 0,
    warn: () => undefined,
  });
  hosts.push(host);
  return { host, configPath };
}

const url = (host: Host, path: string): string =>
  `http://127.0.0.1:${host.port}${path}`;

describe("the provider editor", () => {
  it("reads providers without reading their keys", async () => {
    const { host } = await start();
    const body = (await (
      await fetch(url(host, "/api/llm/v1/providers"))
    ).json()) as {
      providers: { id: string; has_key: boolean; apiKey?: string }[];
    };
    expect(body.providers[0]?.id).toBe("local");
    expect(body.providers[0]?.has_key).toBe(true);
    expect(JSON.stringify(body)).not.toContain("sk-secret-value");
  });

  it("patches one field and keeps everything else, including what it does not know", async () => {
    const { host, configPath } = await start();
    const response = await fetch(url(host, "/api/llm/v1/providers/local"), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: "http://127.0.0.1:2/v1" }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { restart_required: boolean };
    expect(body.restart_required).toBe(true);

    const onDisk = JSON.parse(await readFile(configPath, "utf8")) as {
      somethingNewer?: unknown;
      providers: {
        id: string;
        baseUrl: string;
        apiKey?: string;
        models: unknown;
      }[];
    };
    expect(onDisk.somethingNewer).toEqual({ keep: true });
    expect(onDisk.providers[0]?.baseUrl).toBe("http://127.0.0.1:2/v1");
    // The key was not in the patch, so it is still there.
    expect(onDisk.providers[0]?.apiKey).toBe("sk-secret-value");
    expect(onDisk.providers[0]?.models).toEqual([{ id: "m1" }]);
  });

  it("clears a key only when the patch says null", async () => {
    const { host, configPath } = await start();
    await fetch(url(host, "/api/llm/v1/providers/local"), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: null }),
    });
    const onDisk = JSON.parse(await readFile(configPath, "utf8")) as {
      providers: { apiKey?: string }[];
    };
    expect(onDisk.providers[0]?.apiKey).toBeUndefined();
  });

  it("adds a provider, writes the file 0600, and removes one", async () => {
    const { host, configPath } = await start();
    const created = await fetch(url(host, "/api/llm/v1/providers/second"), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "openai-compatible",
        baseUrl: "http://127.0.0.1:3/v1",
        models: [{ id: "x", input: ["text", "image"] }],
        headers: { "x-test": "1", "x-blank": "" },
      }),
    });
    expect(created.status).toBe(200);
    const mode = (await stat(configPath)).mode & 0o777;
    expect(mode).toBe(0o600);

    const list = (await (
      await fetch(url(host, "/api/llm/v1/providers"))
    ).json()) as {
      providers: { id: string; headers: Record<string, string | null> }[];
    };
    expect(list.providers.map((provider) => provider.id).sort()).toEqual([
      "local",
      "second",
    ]);
    // An empty header value is stored as null: "send nothing", not "send an empty string".
    expect(
      list.providers.find((p) => p.id === "second")?.headers["x-blank"],
    ).toBeNull();

    const removed = await fetch(url(host, "/api/llm/v1/providers/second"), {
      method: "DELETE",
    });
    expect(removed.status).toBe(200);
    const after = (await (
      await fetch(url(host, "/api/llm/v1/providers"))
    ).json()) as {
      providers: { id: string }[];
    };
    expect(after.providers.map((provider) => provider.id)).toEqual(["local"]);
  });

  it("refuses a provider with nothing to run", async () => {
    const { host } = await start();
    const response = await fetch(url(host, "/api/llm/v1/providers/empty"), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: "http://x/v1", models: [] }),
    });
    expect(response.status).toBe(400);
    expect(
      ((await response.json()) as { error: { code: string } }).error.code,
    ).toBe("BAD_MODELS");
  });
});
