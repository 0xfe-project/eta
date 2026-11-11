/**
 * A host for the desktop app: which release it may take, and a download that is either the
 * published file or nothing.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { downloadChecked, hostAsset, hostForDesktop } from "../src/host";
import { ReleaseError, Releases } from "../src/releases";

const NAME = hostAsset("linux", "x64");
const BODY = "a host ".repeat(10_000);
const sha256 = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

interface Fake {
  /** `eta-host.json`'s minDesktop; absent for a release from before it. */
  minDesktop?: string;
  sums?: string;
  /** Send this many bytes of the file, then drop the connection. */
  cutAt?: number;
}

const servers: ReturnType<typeof Bun.serve>[] = [];
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "eta-releases-"));
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop(true)));
  await rm(dir, { recursive: true, force: true });
});

/** GitHub's release API over `releases`, by version, newest last; 404 without `token` when set. */
function fakeApi(releases: Record<string, Fake>, token?: string) {
  const server = Bun.serve({
    port: 0,
    fetch(request): Response {
      const { origin, pathname } = new URL(request.url);
      if (
        token !== undefined &&
        request.headers.get("authorization") !== `Bearer ${token}`
      )
        return new Response("not found", { status: 404 });
      const describe = (version: string) => ({
        tag_name: `v${version}`,
        assets: [
          NAME,
          "SHA256SUMS",
          ...(releases[version]?.minDesktop === undefined
            ? []
            : ["eta-host.json"]),
        ].map((name) => ({ name, url: `${origin}/files/${version}/${name}` })),
      });
      if (pathname === "/repo/releases")
        return Response.json(
          [
            {
              tag_name: "desktop-v9.0.0",
              assets: [] as { name: string; url: string }[],
            },
          ].concat(Object.keys(releases).reverse().map(describe)),
        );
      const [, , version, name] = pathname.split("/");
      const release = version === undefined ? undefined : releases[version];
      if (release === undefined) return new Response("no", { status: 404 });
      if (name === "eta-host.json")
        return Response.json({ version, minDesktop: release.minDesktop });
      if (name === "SHA256SUMS")
        return new Response(release.sums ?? `${sha256(BODY)}  ${NAME}\n`);
      const { cutAt } = release;
      if (cutAt === undefined) return new Response(BODY);
      // Says the whole length, sends part of it, and goes.
      let sent = false;
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (!sent) {
              sent = true;
              controller.enqueue(
                new TextEncoder().encode(BODY.slice(0, cutAt)),
              );
              return;
            }
            await Bun.sleep(50);
            controller.error(new Error("connection reset"));
          },
        }),
        { headers: { "content-length": String(BODY.length) } },
      );
    },
  });
  servers.push(server);
  return `http://127.0.0.1:${String(server.port)}/repo`;
}

const releasesOf = (upstream: string) =>
  new Releases({ upstream, token: () => Promise.resolve({}) });

const caught = async (promise: Promise<unknown>): Promise<ReleaseError> => {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(ReleaseError);
  return error as ReleaseError;
};

describe("the host an app may take", () => {
  it("is the newest whose page works in this app", async () => {
    const releases = releasesOf(
      fakeApi({
        "0.3.0": { minDesktop: "0.1.0" },
        "0.4.0": { minDesktop: "0.1.0" },
        "0.5.0": { minDesktop: "0.2.0" },
      }),
    );
    expect((await hostForDesktop(releases, "0.1.5", NAME)).version).toBe(
      "0.4.0",
    );
    expect((await hostForDesktop(releases, "0.2.0", NAME)).version).toBe(
      "0.5.0",
    );
  });

  it("is never one from before releases said", async () => {
    const releases = releasesOf(
      fakeApi({ "0.2.0": {}, "0.3.0": { minDesktop: "0.3.0" } }),
    );
    const error = await caught(hostForDesktop(releases, "0.2.0", NAME));
    expect(error.kind).toBe("none");
    expect(error.message).toContain("0.3.0 needs the app 0.3.0");
  });
});

describe("a download", () => {
  it("is the published file, with its progress", async () => {
    const releases = releasesOf(fakeApi({ "0.3.0": { minDesktop: "0.1.0" } }));
    const file = await hostForDesktop(releases, "0.1.0", NAME);
    const seen: number[] = [];
    const path = join(dir, "eta-host");
    await downloadChecked(releases, file, path, (received, total) => {
      expect(total).toBe(BODY.length);
      seen.push(received);
    });
    expect(await Bun.file(path).text()).toBe(BODY);
    expect(seen.at(-1)).toBe(BODY.length);
  });

  it("leaves nothing when it is not what was published", async () => {
    const releases = releasesOf(
      fakeApi({
        "0.3.0": { minDesktop: "0.1.0", sums: `${"0".repeat(64)}  ${NAME}\n` },
      }),
    );
    const file = await hostForDesktop(releases, "0.1.0", NAME);
    const path = join(dir, "eta-host");
    expect((await caught(downloadChecked(releases, file, path))).kind).toBe(
      "checksum",
    );
    expect(existsSync(path)).toBe(false);
  });

  it("leaves nothing when it stops partway", async () => {
    const releases = releasesOf(
      fakeApi({ "0.3.0": { minDesktop: "0.1.0", cutAt: 1000 } }),
    );
    const file = await hostForDesktop(releases, "0.1.0", NAME);
    const path = join(dir, "eta-host");
    expect((await caught(downloadChecked(releases, file, path))).kind).toBe(
      "interrupted",
    );
    expect(await readdir(dir)).toEqual([]);
  });
});

describe("a failure", () => {
  it("says nothing answered", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("") });
    const upstream = `http://127.0.0.1:${String(server.port)}/repo`;
    await server.stop(true);
    const error = await caught(hostForDesktop(releasesOf(upstream), "0.1.0"));
    expect(error.kind).toBe("offline");
  });

  it("says there was no token to ask a private repository with", async () => {
    const upstream = fakeApi({ "0.3.0": { minDesktop: "0.1.0" } }, "secret");
    const error = await caught(hostForDesktop(releasesOf(upstream), "0.1.0"));
    expect(error.kind).toBe("refused");
  });
});
