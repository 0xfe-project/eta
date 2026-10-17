import type { Host } from "../src/host";
/**
 * The host serving the web (REFACTOR.md §9, P3.11).
 *
 * The claim is the shape of the whole surface in one process: the SPA's files come from the same
 * port the API does, a deep link into the app renders the app rather than a 404, and — the half
 * that is easy to get wrong — a wrong guess at an API path still answers the API's error envelope
 * and not the app's HTML. `/up` and `/version` are what a deployment watches, unchanged from the
 * gateway that used to answer them.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

const CONFIG = { providers: [], defaultModel: "" };

const url = (host: Host, path: string): string =>
  `http://127.0.0.1:${host.port}${path}`;

/** A bundle that looks like a built SPA: an index, an asset, a nested asset, a build id. */
async function bundle(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eta-web-"));
  roots.push(root);
  await mkdir(join(root, "assets"), { recursive: true });
  await writeFile(join(root, "BUILD"), "build-1\n", "utf8");
  await writeFile(
    join(root, "index.html"),
    '<!doctype html><html><body><div id="root"></div><script src="/assets/app.js"></script></body></html>',
    "utf8",
  );
  await writeFile(
    join(root, "assets", "app.js"),
    "console.log('the app')",
    "utf8",
  );
  await writeFile(
    join(root, "assets", "deep", "style.css"),
    "body{color:red}",
    "utf8",
  ).catch(async () => {
    await mkdir(join(root, "assets", "deep"), { recursive: true });
    await writeFile(
      join(root, "assets", "deep", "style.css"),
      "body{color:red}",
      "utf8",
    );
  });
  return root;
}

async function start(webDir?: string): Promise<Host> {
  const root = await mkdtemp(join(tmpdir(), "eta-static-"));
  roots.push(root);
  await writeFile(join(root, "config.json"), JSON.stringify(CONFIG), "utf8");
  const host = await assembleHost({
    dataDir: root,
    port: 0,
    warn: () => undefined,
    ...(webDir === undefined ? {} : { webDir }),
  });
  hosts.push(host);
  return host;
}

describe("one process, the app and the API", () => {
  it("serves the bundle and its assets, with the types they are", async () => {
    const host = await start(await bundle());
    const index = await fetch(url(host, "/"));
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toContain("text/html");
    expect(await index.text()).toContain('<div id="root">');

    const asset = await fetch(url(host, "/assets/app.js"));
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("javascript");
    expect(await asset.text()).toBe("console.log('the app')");
    // Hashed names are immutable; the index is what must be re-read.
    expect(asset.headers.get("cache-control")).toContain("immutable");
    expect(index.headers.get("cache-control")).toContain("no-cache");

    const deep = await fetch(url(host, "/assets/deep/style.css"));
    expect(deep.status).toBe(200);
    expect(deep.headers.get("content-type")).toContain("text/css");
  });

  it("falls back to the app for a deep link, and to JSON for an API guess", async () => {
    const host = await start(await bundle());
    // The router lives in the browser: /workspace/tasks is a page.
    const link = await fetch(url(host, "/workspace/tasks"));
    expect(link.status).toBe(200);
    expect(link.headers.get("content-type")).toContain("text/html");
    expect(await link.text()).toContain('<div id="root">');

    // A path under the host's own prefixes is nobody's page.
    const api = await fetch(url(host, "/api/v1/nope"));
    expect(api.status).toBe(404);
    expect(api.headers.get("content-type")).toContain("application/json");
    expect(
      ((await api.json()) as { error: { code: string } }).error.code,
    ).toBeTruthy();

    // The traversal that must not work, does not.
    for (const escape of [
      "/../config.json",
      "/%2e%2e/config.json",
      "/assets/../../config.json",
    ]) {
      const attempt = await fetch(url(host, escape));
      expect(attempt.status, escape).toBe(200);
      expect(attempt.headers.get("content-type")).toContain("text/html");
    }
  });

  it("answers /up and /version, and the plugin lists honestly", async () => {
    const host = await start(await bundle());
    const up = await fetch(url(host, "/up"));
    expect(up.status).toBe(200);
    expect(await up.text()).toBe("ok");

    // The page's build id, not the process's: a tab compares this with the id its own bundle
    // was built with (apps/web/src/lib/update.ts), so anything else reads as "an update is
    // waiting" on every tab forever.
    const version = await fetch(url(host, "/version"));
    expect(version.status).toBe(200);
    expect(version.headers.get("cache-control")).toBe("no-store");
    expect(await version.text()).toBe("build-1");

    // The process's own identity lives at /host, where a caller asks "which process is this".
    const identity = (await (await fetch(url(host, "/host"))).json()) as {
      pid: number;
      version: string;
      startedAt: number;
    };
    expect(identity.pid).toBe(process.pid);
    expect(identity.version).toBe("0.0.0");
    expect(identity.startedAt).toBeGreaterThan(0);

    // The bundle/plugin manager is P3.6; until then the honest answer is an empty list, which
    // the agent editor reads as "nothing to choose".
    expect(
      await await (await fetch(url(host, "/api/v1/plugins"))).json(),
    ).toEqual([]);
    expect(
      await await (await fetch(url(host, "/api/v1/bundles"))).json(),
    ).toEqual([]);
  });

  it("is exactly the host it was when no bundle is given", async () => {
    const host = await start();
    // No bundle: nothing serves the web, and a page path is a 404 like before it existed.
    const page = await fetch(url(host, "/workspace/tasks"));
    expect(page.status).toBe(404);
    expect(page.headers.get("content-type")).toContain("application/json");
    // The API is untouched either way.
    const health = await fetch(url(host, "/health"));
    expect(health.status).toBe(200);
  });
});
