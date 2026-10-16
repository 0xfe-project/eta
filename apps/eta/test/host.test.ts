import type { Host } from "../src/host";
/**
 * The host (REFACTOR.md §9, P0.3).
 *
 * Three claims, and each has a test: the floor answers with no plugins at all, a plugin that is
 * mounted is visible and can add a route, and `close()` takes back everything it gave out — so
 * "kill the process" is a shutdown rather than a leak. The last one is the reason this file
 * exists: a host that cannot stop cleanly is a host that cannot be restarted by a supervisor.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assembleHost } from "../src/host";

const roots: string[] = [];
const hosts: Host[] = [];
const warnings: string[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
  warnings.splice(0);
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eta-host-"));
  roots.push(root);
  return root;
}

async function start(dataDir: string): Promise<Host> {
  const host = await assembleHost({
    dataDir,
    port: 0,
    warn: (message) => warnings.push(message),
  });
  hosts.push(host);
  return host;
}

/** Write a user plugin where the plugin manager looks for one. */
async function writeUserPlugin(
  dataDir: string,
  name: string,
  code: string,
): Promise<void> {
  const directory = join(dataDir, "plugins", name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ name, "eta-plugin": true }),
    "utf8",
  );
  await writeFile(join(directory, "index.ts"), code, "utf8");
}

const url = (host: Host, path: string): string =>
  `http://127.0.0.1:${host.port}${path}`;

describe("the floor", () => {
  it("answers /health, and says NOT_FOUND in the one error shape", async () => {
    const host = await start(await scratch());

    const health = await fetch(url(host, "/health"));
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });
    expect(health.headers.get("x-request-id")).toBeTruthy();

    const missing = await fetch(url(host, "/nope"));
    expect(missing.status).toBe(404);
    const body = (await missing.json()) as {
      error: { code: string; request_id: string };
    };
    expect(body.error.code).toBe("NOT_FOUND");
    // The id in the body is the id on the response, so a log line and a report agree.
    expect(body.error.request_id).toBe(missing.headers.get("x-request-id"));
  });

  it("keeps the request id a caller sent", async () => {
    const host = await start(await scratch());
    const response = await fetch(url(host, "/health"), {
      headers: { "x-request-id": "abc" },
    });
    expect(response.headers.get("x-request-id")).toBe("abc");
  });

  it("starts without a config file and says so", async () => {
    const dataDir = await scratch();
    const host = await start(dataDir);
    expect(host.config.providers).toEqual([]);
    expect(warnings.join("\n")).toContain("no config at");
    expect((await fetch(url(host, "/health"))).status).toBe(200);
  });

  it("reads the providers the config file lists", async () => {
    const dataDir = await scratch();
    await writeFile(
      join(dataDir, "config.json"),
      JSON.stringify({
        providers: [{ id: "local", baseUrl: "http://127.0.0.1:1/v1" }],
      }),
      "utf8",
    );
    const host = await start(dataDir);
    expect(host.config.providers.map((provider) => provider.id)).toEqual([
      "local",
    ]);
  });
});

describe("the plugins", () => {
  it("answers for itself: /host reports the pid, the data directory and the mounted plugins", async () => {
    const dataDir = await scratch();
    const host = await start(dataDir);
    const body = (await (await fetch(url(host, "/host"))).json()) as {
      pid: number;
      dataDir: string;
      mounted: string[];
    };
    expect(body.pid).toBe(process.pid);
    expect(body.dataDir).toBe(dataDir);
    expect(body.mounted).toEqual([]);
  });

  it("mounts a user plugin, and its route answers", async () => {
    const dataDir = await scratch();
    await writeUserPlugin(
      dataDir,
      "mine",
      `
				export default {
					name: "mine",
					inject: ["routes"],
					apply(ctx) {
						ctx.effect(() => ctx.routes.register("GET", "/mine", () => Response.json({ hello: "world" })));
					},
				};
			`,
    );
    const host = await start(dataDir);
    expect(host.mounted().map((plugin) => plugin.name)).toEqual(["mine"]);
    expect(await (await fetch(url(host, "/mine"))).json()).toEqual({
      hello: "world",
    });
    // And the host says so too, which is what a person checks when something is missing.
    expect(
      (
        (await (await fetch(url(host, "/host"))).json()) as {
          mounted: string[];
        }
      ).mounted,
    ).toEqual(["mine"]);
  });

  it("reports a broken plugin instead of refusing to start", async () => {
    const dataDir = await scratch();
    await writeUserPlugin(
      dataDir,
      "broken",
      `throw new Error("this plugin is broken");`,
    );
    const host = await start(dataDir);
    expect((await fetch(url(host, "/health"))).status).toBe(200);
    expect(host.mounted()[0]?.error).toContain("broken");
  });
});

describe("stopping", () => {
  it("takes back every route and releases the port", async () => {
    const host = await start(await scratch());
    // Two from the floor (/health, /events), one from the bundled host plugin (/host).
    expect(host.routes.routes().length).toBe(3);
    const port = host.port;

    await host.close();
    hosts.splice(hosts.indexOf(host), 1);

    expect(host.routes.routes()).toEqual([]);
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  });

  it("can be closed twice without complaining", async () => {
    const host = await start(await scratch());
    await host.close();
    await expect(host.close()).resolves.toBeUndefined();
    hosts.splice(hosts.indexOf(host), 1);
  });
});
