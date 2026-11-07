import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hostHome, recordedHost, runningHost } from "../src/bun/installed";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "eta-installed-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("a host already serving the data directory, before there is a host file", () => {
  it("is opened when its record names a live process that answers", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("ok"),
    });
    const data = join(dir, ".eta");
    await Bun.write(
      join(data, "running-host.json"),
      JSON.stringify({
        pid: process.pid,
        hostname: "127.0.0.1",
        port: server.port,
        tokenFile: null,
      }),
    );
    expect(await recordedHost(data)).toEqual({
      address: `http://127.0.0.1:${String(server.port)}`,
      token: "",
    });
    await server.stop(true);
    expect(await recordedHost(data)).toBeUndefined();
  });

  it("is nothing without a record, or with a dead one", async () => {
    const data = join(dir, ".eta");
    expect(await recordedHost(data)).toBeUndefined();
    await Bun.write(
      join(data, "running-host.json"),
      JSON.stringify({
        pid: 2 ** 22 + 7,
        hostname: "127.0.0.1",
        port: 1,
        tokenFile: null,
      }),
    );
    expect(await recordedHost(data)).toBeUndefined();
  });

  it("lives under the user's .eta", () => {
    expect(hostHome(join(dir, "home"))).toBe(
      join(dir, "home", ".eta", "desktop", "host"),
    );
  });
});

/** A host's `running` answer, as a script prints it. */
async function answering(output: string, code = 0): Promise<string[]> {
  const script = join(dir, "running.ts");
  await writeFile(
    script,
    `console.log(${JSON.stringify(output)}); process.exit(${String(code)});`,
  );
  return [process.execPath, script];
}

describe("asking for a host already running", () => {
  it("opens what the host names, with the token from its file", async () => {
    const tokenFile = join(dir, "access-token");
    await writeFile(tokenFile, "s3cret-token-of-sixteen\n");
    const found = await runningHost(
      await answering(
        JSON.stringify({
          address: "http://127.0.0.1:8790",
          tokenFile,
          from: "service",
        }),
      ),
      dir,
      process.env,
    );
    expect(found).toEqual({
      address: "http://127.0.0.1:8790",
      token: "s3cret-token-of-sixteen",
    });
  });

  it("finds nothing in null, a failure or a build that does not know the question", async () => {
    expect(
      await runningHost(await answering("null"), dir, process.env),
    ).toBeUndefined();
    expect(
      await runningHost(
        await answering("Usage: eta-host", 2),
        dir,
        process.env,
      ),
    ).toBeUndefined();
    expect(
      await runningHost([join(dir, "missing")], dir, process.env),
    ).toBeUndefined();
    expect(existsSync(join(dir, "missing"))).toBe(false);
  });
});
