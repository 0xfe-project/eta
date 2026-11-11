/**
 * The app's first host: downloaded beside where it goes, run once, and only then the host.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadHost } from "../src/bun/download";

const BODY = "#!/bin/sh\necho eta-host 0.3.0\n";
const ASSET = "eta-host-windows-x64.exe";

let dir: string;
let server: ReturnType<typeof Bun.serve>;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "eta-download-"));
  server = Bun.serve({
    port: 0,
    fetch(request): Response {
      const { origin, pathname } = new URL(request.url);
      if (pathname === "/repo/releases")
        return Response.json([
          {
            tag_name: "v0.3.0",
            assets: [ASSET, "SHA256SUMS", "eta-host.json"].map((name) => ({
              name,
              url: `${origin}/files/${name}`,
            })),
          },
        ]);
      if (pathname === "/files/eta-host.json")
        return Response.json({ version: "0.3.0", minDesktop: "0.1.0" });
      if (pathname === "/files/SHA256SUMS")
        return new Response(
          `${createHash("sha256").update(BODY).digest("hex")}  ${ASSET}\n`,
        );
      if (pathname === `/files/${ASSET}`) return new Response(BODY);
      return new Response("not found", { status: 404 });
    },
  });
});
afterEach(async () => {
  await server.stop(true);
  await rm(dir, { recursive: true, force: true });
});

// The Windows names, wherever this runs: the asset is chosen by the release, not by this computer.
vi.mock("@eta/releases", async (original) => {
  const actual = await original<typeof import("@eta/releases")>();
  return {
    ...actual,
    hostForDesktop: (releases: never, appVersion: string) =>
      actual.hostForDesktop(releases, appVersion, ASSET),
  };
});

const options = (tryBuild: (file: string) => Promise<string>) => ({
  dir,
  name: "eta-host.exe",
  appVersion: "0.2.0",
  env: { ETA_RELEASES_URL: `http://127.0.0.1:${String(server.port)}/repo` },
  onProgress: () => {},
  tryBuild,
});

describe("the app's first host", () => {
  it("is tried under a name Windows will run, then becomes the host", async () => {
    const tried: string[] = [];
    const file = await downloadHost(
      options(async (path) => {
        tried.push(path);
        return "eta-host 0.3.0 (abc)";
      }),
    );
    expect(tried[0]).toMatch(/eta-host\.\d+\.download\.exe$/);
    expect(file).toBe(join(dir, "eta-host.exe"));
    expect(await readdir(dir)).toEqual(["eta-host.exe"]);
  });

  it("leaves nothing when it does not run", async () => {
    await expect(
      downloadHost(
        options(async () => {
          throw new Error("not a program");
        }),
      ),
    ).rejects.toMatchObject({ failure: { kind: "broken" } });
    expect(await readdir(dir)).toEqual([]);
  });

  it("leaves nothing when it says another version", async () => {
    await expect(
      downloadHost(options(async () => "eta-host 9.9.9")),
    ).rejects.toMatchObject({ failure: { kind: "broken" } });
    expect(await readdir(dir)).toEqual([]);
  });
});
