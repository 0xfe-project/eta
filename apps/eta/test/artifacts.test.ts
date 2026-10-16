import type { Host } from "../src/host";
/**
 * Artifacts (REFACTOR.md §9, P3.2).
 *
 * What is checked here is the whole of what a user does with one, and the security that makes it
 * safe to serve somebody else's HTML from our own address:
 *
 *   publish   a ZIP becomes an artifact, a second publish becomes a version
 *   preview   a one-hour capability in the path serves the files, sandboxed and un-referrable
 *   share     a token opens a public page, and the files under it
 *   revoke    the link stops working, forever
 *
 * And the failures, told apart because a caller acts differently on each: a package that is not a
 * site is 422 `INVALID_ARTIFACT` (nothing stored), a store that failed is 424 `STORAGE_FAILED`
 * (cleaned up), and a version attempted by somebody who does not own the artifact is 403.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactService } from "../src/artifacts/service";
import { writeZip } from "../src/artifacts/zip";
import { applyMigrations, loadMigrations } from "../src/db/migrations";
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

const siteZip = (files: Record<string, string>): Uint8Array =>
  writeZip(
    Object.entries(files).map(([name, text]) => ({
      name,
      bytes: new TextEncoder().encode(text),
    })),
  );

async function start(): Promise<Host> {
  const root = await mkdtemp(join(tmpdir(), "eta-artifacts-"));
  roots.push(root);
  await writeFile(join(root, "config.json"), JSON.stringify(CONFIG), "utf8");
  const host = await assembleHost({
    dataDir: root,
    port: 0,
    warn: () => undefined,
  });
  hosts.push(host);
  return host;
}

interface Version {
  number: number;
  files: number;
  preview_url: string;
  share?: { url: string; created_at: string };
}

interface Artifact {
  id: string;
  title: string;
  agent_id: string | null;
  task_id: string | null;
  versions: Version[];
}

const upload = async (
  host: Host,
  archive: Uint8Array,
  query: Record<string, string>,
): Promise<Response> =>
  fetch(
    url(host, `/artifacts/v1/upload?${new URLSearchParams(query).toString()}`),
    {
      method: "POST",
      headers: { "content-type": "application/zip" },
      body: archive,
    },
  );

describe("publishing a site", () => {
  it("publishes a package, previews it, and serves its files", async () => {
    const host = await start();
    const response = await upload(
      host,
      siteZip({
        "index.html": "<h1>hello</h1>",
        "assets/app.js": "console.log(1)",
      }),
      { title: "第一个站点", agent: "agent-1" },
    );
    expect(response.status).toBe(201);
    const artifact = (await response.json()) as Artifact;
    expect(artifact).toMatchObject({
      title: "第一个站点",
      agent_id: "agent-1",
    });
    expect(artifact.versions).toHaveLength(1);
    expect(artifact.versions[0]?.files).toBe(2);

    // The preview address it handed out works, and the page is the site's.
    const preview = await fetch(url(host, artifact.versions[0]!.preview_url));
    expect(preview.status).toBe(200);
    expect(await preview.text()).toBe("<h1>hello</h1>");
    // Sandboxed, un-referrable, and readable by an opaque origin — the three headers that make
    // serving somebody else's HTML safe.
    expect(preview.headers.get("content-security-policy")).toContain("sandbox");
    expect(preview.headers.get("content-security-policy")).not.toContain(
      "allow-same-origin",
    );
    expect(preview.headers.get("referrer-policy")).toBe("no-referrer");
    expect(preview.headers.get("access-control-allow-origin")).toBe("*");

    // A relative asset resolves under the same capability, as the page expects.
    const asset = await fetch(
      url(
        host,
        artifact.versions[0]!.preview_url.replace(
          "index.html",
          "assets/app.js",
        ),
      ),
    );
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("javascript");
    expect(await asset.text()).toBe("console.log(1)");

    // A capability nobody minted opens nothing, and neither does a made-up file.
    expect(
      (await fetch(url(host, "/preview/artifacts/nonsense/files/index.html")))
        .status,
    ).toBe(404);
    expect(
      (
        await fetch(
          url(
            host,
            artifact.versions[0]!.preview_url.replace("index.html", "nope.txt"),
          ),
        )
      ).status,
    ).toBe(404);
  });

  it("adds a version to the same artifact, and refuses another publisher", async () => {
    const host = await start();
    const first = (await (
      await upload(host, siteZip({ "index.html": "one" }), {
        title: "站点",
        agent: "agent-1",
      })
    ).json()) as Artifact;

    const second = (await (
      await upload(host, siteZip({ "index.html": "two" }), {
        title: "站点",
        agent: "agent-1",
        artifact: first.id,
      })
    ).json()) as Artifact;
    expect(second.id).toBe(first.id);
    expect(second.versions.map((version) => version.number)).toEqual([2, 1]);

    // Somebody else publishing into it is refused: an artifact has one publisher.
    const stranger = await upload(host, siteZip({ "index.html": "three" }), {
      title: "站点",
      agent: "agent-2",
      artifact: first.id,
    });
    expect(stranger.status).toBe(403);
    expect(
      ((await stranger.json()) as { error: { code: string } }).error.code,
    ).toBe("NOT_PUBLISHER");

    // And the list shows one artifact with two versions, not three artifacts.
    const list = (await (
      await fetch(url(host, "/api/v1/artifacts"))
    ).json()) as {
      artifacts: Artifact[];
    };
    expect(list.artifacts).toHaveLength(1);
    expect(list.artifacts[0]?.versions).toHaveLength(2);
  });

  it("refuses a package that is not a site, and stores nothing", async () => {
    const host = await start();
    const response = await upload(
      host,
      siteZip({ "page.html": "<h1>no index</h1>" }),
      {
        title: "坏包",
      },
    );
    expect(response.status).toBe(422);
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("INVALID_ARTIFACT");
    expect(body.error.message).toContain("index.html");

    // Nothing was written down, and nothing is on disk.
    const list = (await (
      await fetch(url(host, "/api/v1/artifacts"))
    ).json()) as {
      artifacts: Artifact[];
    };
    expect(list.artifacts).toEqual([]);
    // Nothing under the objects' root either: the refusal happens before anything is written.
    expect(existsSync(join(host.db.path, "..", "artifacts"))).toBe(false);

    // A body that is not a ZIP at all is the same refusal, not a 500.
    const notZip = await upload(host, new TextEncoder().encode("hello"), {
      title: "不是包",
    });
    expect(notZip.status).toBe(422);
  });
});

describe("sharing a version", () => {
  it("opens a public page and its files, and stops working when revoked", async () => {
    const host = await start();
    const artifact = (await (
      await upload(host, siteZip({ "index.html": "<h1>shared</h1>" }), {
        title: "分享站点",
        agent: "agent-1",
      })
    ).json()) as Artifact;

    const shared = (await (
      await fetch(
        url(host, `/api/v1/artifacts/${artifact.id}/versions/1/share`),
        { method: "PUT" },
      )
    ).json()) as { url: string };
    expect(shared.url).toMatch(/^\/share\/artifacts\/.+\/$/);

    const page = await fetch(url(host, shared.url));
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("分享站点");
    expect(html).toContain(`src="${shared.url}files/index.html"`);
    // The shell runs nothing and loads nothing of ours.
    expect(page.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'",
    );
    expect(page.headers.get("cache-control")).toBe("no-store");

    const file = await fetch(url(host, `${shared.url}files/index.html`));
    expect(file.status).toBe(200);
    expect(await file.text()).toBe("<h1>shared</h1>");
    expect(file.headers.get("cache-control")).toBe("no-store");
    expect(file.headers.get("content-security-policy")).toContain("sandbox");

    const archive = await fetch(url(host, `${shared.url}archive.zip`));
    expect(archive.status).toBe(200);
    expect(archive.headers.get("content-type")).toBe("application/zip");

    // The detail carries the link while it is shared.
    const detail = (await (
      await fetch(url(host, `/api/v1/artifacts/${artifact.id}`))
    ).json()) as Artifact;
    expect(detail.versions[0]?.share?.url).toBe(shared.url);

    // Revoked: the page and every file under it are gone, and the token stays dead.
    expect(
      (
        await fetch(
          url(host, `/api/v1/artifacts/${artifact.id}/versions/1/share`),
          {
            method: "DELETE",
          },
        )
      ).status,
    ).toBe(204);
    const after = await fetch(url(host, shared.url));
    expect(after.status).toBe(404);
    expect(await after.text()).toContain("这个分享不存在");
    expect(
      (await fetch(url(host, `${shared.url}files/index.html`))).status,
    ).toBe(404);

    // Sharing again mints a new token rather than reviving the old one.
    const again = (await (
      await fetch(
        url(host, `/api/v1/artifacts/${artifact.id}/versions/1/share`),
        {
          method: "PUT",
        },
      )
    ).json()) as { url: string };
    expect(again.url).not.toBe(shared.url);
    expect((await fetch(url(host, again.url))).status).toBe(200);
    expect((await fetch(url(host, shared.url))).status).toBe(404);
  });

  it("removes an artifact with its bytes", async () => {
    const host = await start();
    const artifact = (await (
      await upload(host, siteZip({ "index.html": "bye" }), {
        title: "要删的",
        agent: "a",
      })
    ).json()) as Artifact;
    const preview = artifact.versions[0]!.preview_url;
    expect((await fetch(url(host, preview))).status).toBe(200);

    expect(
      (
        await fetch(url(host, `/api/v1/artifacts/${artifact.id}`), {
          method: "DELETE",
        })
      ).status,
    ).toBe(204);
    expect((await fetch(url(host, preview))).status).toBe(404);
    const list = (await (
      await fetch(url(host, "/api/v1/artifacts"))
    ).json()) as {
      artifacts: Artifact[];
    };
    expect(list.artifacts).toEqual([]);
  });
});

describe("a store that cannot be written", () => {
  it("fails the version and says so, rather than leaving half a site", async () => {
    const root = await mkdtemp(join(tmpdir(), "eta-artifacts-store-"));
    roots.push(root);
    const handle = new Database(join(root, "eta.sqlite"));
    applyMigrations(handle, await loadMigrations());
    // A file where the objects' directory should be: every write fails.
    const blocked = join(root, "blocked");
    await writeFile(blocked, "not a directory", "utf8");
    const service = new ArtifactService({
      handle,
      objectsRoot: blocked,
      secretPath: join(root, "secret.key"),
    });
    await expect(
      service.publish({
        title: "存不下",
        archive: siteZip({ "index.html": "x" }),
      }),
    ).rejects.toThrow();

    const artifact = service.list()[0];
    expect(artifact).toBeDefined();
    const versions = service.versions(artifact!.id);
    expect(versions[0]).toMatchObject({ number: 1, status: "failed" });
    expect(versions[0]?.error).toBeTruthy();
    handle.close();
  });

  it("cleans a version a crash left processing", async () => {
    const root = await mkdtemp(join(tmpdir(), "eta-artifacts-stale-"));
    roots.push(root);
    const handle = new Database(join(root, "eta.sqlite"));
    applyMigrations(handle, await loadMigrations());
    const service = new ArtifactService({
      handle,
      objectsRoot: join(root, "artifacts"),
      secretPath: join(root, "secret.key"),
      // Nothing is fresh enough: what a crash left behind is stale immediately.
      staleMs: -1,
    });
    const published = await service.publish({
      title: "上次没写完",
      archive: siteZip({ "index.html": "x" }),
    });
    // What a crash leaves: a version that never reached `published`. Written directly, because
    // that is the state a killed process leaves behind.
    handle
      .query(
        "UPDATE artifact_version SET status = 'processing', published_at = NULL WHERE id = ?",
      )
      .run(published.version.id);
    // The next publish cleans it: a version nobody can read keeps a number and a prefix forever.
    const stale = await service.cleanStale();
    expect(stale.map((version) => version.id)).toContain(published.version.id);
    expect(
      service.version(published.artifact.id, published.version.number)?.status,
    ).toBe("failed");
    expect(
      await service.file(
        published.artifact.id,
        published.version.number,
        "index.html",
      ),
    ).toBeUndefined();
    handle.close();
  });
});
