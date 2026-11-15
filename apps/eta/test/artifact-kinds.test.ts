/**
 * Kinds of artifact: what a kind may decide and what stays with the core, proved with a kind the
 * routes and the service have never heard of, and the migration that made every old version a site.
 */
import type { Database } from "bun:sqlite";
import type { ArtifactKinds } from "../src/artifacts/kinds";
import type { ArtifactKind } from "../src/artifacts/kinds/kind";
import { Buffer } from "node:buffer";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_LIMITS } from "../src/artifacts/files";
import { artifactKinds, KINDS } from "../src/artifacts/kinds";
import { kind } from "../src/artifacts/kinds/kind";
import { site } from "../src/artifacts/kinds/site";
import { createArtifactRoutes } from "../src/artifacts/routes";
import { ArtifactService } from "../src/artifacts/service";
import { ArtifactStore } from "../src/artifacts/store";
import {
  applyMigrations,
  databasePath,
  loadMigrations,
  openDatabase,
} from "../src/db";
import { tempDir } from "./support/host";

const open: Database[] = [];

afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

async function database(): Promise<Database> {
  const db = openDatabase(databasePath(join(await tempDir(), "data")));
  open.push(db);
  return db;
}

/** A kind nothing in the core knows: it answers with fixed text, and asks for all it can get. */
const note = kind<{ words: string }>({
  id: "note",
  viewer: "download",
  prepare: (_files, options) => ({ words: String(options) }),
  entry: () => "",
  respond: (request, _version, manifest) =>
    Promise.resolve(
      new Response(`${manifest.words} at ${request.path}`, {
        status: request.path === "gone" ? 410 : 200,
        headers: {
          "content-type": "text/plain",
          "content-security-policy": "default-src *",
          "referrer-policy": "unsafe-url",
          "x-content-type-options": "sniff",
          "cache-control": "public, max-age=31536000",
          "set-cookie": "session=stolen",
        },
      }),
    ),
});

const files = [{ name: "index.html", bytes: Buffer.from("<h1>hi</h1>") }];

async function bench(kinds: ArtifactKinds, db?: Database) {
  const database_ = db ?? (await database());
  if (db === undefined) applyMigrations(database_, loadMigrations());
  const root = await tempDir();
  const service = (given: ArtifactKinds) =>
    new ArtifactService({
      store: new ArtifactStore(database_),
      root,
      limits: DEFAULT_LIMITS,
      kinds: given,
      key: Buffer.from("key"),
      changed: () => undefined,
    });
  const artifacts = service(kinds);
  const get = (path: string, accept?: string) =>
    createArtifactRoutes(artifacts)(
      new Request(`http://host${path}`, {
        ...(accept === undefined ? {} : { headers: { accept } }),
      }),
    ) as Promise<Response>;
  return { db: database_, artifacts, service, get };
}

describe("a kind the core has never heard of", () => {
  it("publishes and answers without the routes or the service knowing it", async () => {
    const { artifacts, get } = await bench(artifactKinds([site, note]));
    const { artifact, version } = await artifacts.publish({
      title: "Note",
      files,
      kind: "note",
      options: "hello",
      publisherAgentId: "ada",
    });
    expect(version).toMatchObject({
      kind: "note",
      manifest: '{"words":"hello"}',
    });
    expect(artifacts.view(artifact.id)!.versions[0]).toMatchObject({
      kind: "note",
      viewer: "download",
    });

    const { url } = artifacts.preview(artifact.id, 1);
    expect(url).toMatch(/\/files\/$/);
    const page = await get(`${url}deep/path`);
    expect(page.status).toBe(200);
    expect(await page.text()).toBe("hello at deep/path");
  });

  it("is sealed in the sandbox whatever it answers, on every way in", async () => {
    const { artifacts, get } = await bench(artifactKinds([site, note]));
    const { artifact } = await artifacts.publish({
      title: "Note",
      files,
      kind: "note",
      options: "hello",
      publisherAgentId: "ada",
    });
    const preview = artifacts.preview(artifact.id, 1).url;
    const share = artifacts.view(artifact.id)!.versions[0]!.shareUrl;
    expect(share).toBeNull();
    const shared = artifacts.share(artifact.id, 1).versions[0]!.shareUrl!;

    for (const url of [preview, `${preview}gone`, `${shared}files/`]) {
      const { headers } = await get(url);
      const csp = headers.get("content-security-policy");
      expect(csp, url).toMatch(/^sandbox allow-scripts /);
      expect(csp, url).not.toContain("allow-same-origin");
      expect(csp, url).not.toContain("default-src");
      expect(headers.get("referrer-policy"), url).toBe("no-referrer");
      expect(headers.get("x-content-type-options"), url).toBe("nosniff");
      expect(headers.get("set-cookie"), url).toBeNull();
      expect(headers.get("cache-control"), url).not.toContain("public");
    }
    // A share can be taken back, so nothing of it is kept, whatever the kind says.
    expect((await get(`${shared}files/`)).headers.get("cache-control")).toBe(
      "no-store",
    );
    expect((await get(`${preview}gone`)).headers.get("cache-control")).toBe(
      "no-store",
    );
    // A kind is asked only after the capability or the share has opened the version.
    artifacts.unshare(artifact.id, 1);
    expect((await get(`${shared}files/`)).status).toBe(404);
  });

  it("refuses a kind that does not exist, before anything is stored", async () => {
    const { artifacts, db } = await bench(KINDS);
    await expect(
      artifacts.publish({
        title: "x",
        files,
        kind: "nope",
        publisherAgentId: "ada",
      }),
    ).rejects.toThrow("no such kind of artifact: nope");
    expect(db.query("SELECT COUNT(*) AS n FROM artifact").get()).toEqual({
      n: 0,
    });
  });

  it("never lets a kind store a path the core would refuse", async () => {
    let asked = false;
    const eager: ArtifactKind = {
      ...note,
      id: "eager",
      prepare: () => {
        asked = true;
        return {};
      },
    };
    const { artifacts } = await bench(artifactKinds([eager]));
    await expect(
      artifacts.publish({
        title: "x",
        files: [{ name: "../out", bytes: new Uint8Array() }],
        kind: "eager",
        publisherAgentId: "ada",
      }),
    ).rejects.toThrow(/clean path/);
    expect(asked).toBe(false);
  });

  it("leaves a version whose kind this host lost as its ZIP, and nothing else", async () => {
    const { artifacts, service } = await bench(artifactKinds([site, note]));
    const { artifact } = await artifacts.publish({
      title: "Note",
      files,
      kind: "note",
      options: "hello",
      publisherAgentId: "ada",
    });
    const shared = artifacts.share(artifact.id, 1).versions[0]!.shareUrl!;

    const without = service(KINDS);
    const get = (path: string) =>
      createArtifactRoutes(without)(new Request(`http://host${path}`));
    expect(without.view(artifact.id)!.versions[0]).toMatchObject({
      kind: "note",
      viewer: "download",
    });
    expect((await get(`${shared}files/`))!.status).toBe(404);
    const preview = without.preview(artifact.id, 1).url;
    expect((await get(preview))!.status).toBe(404);
    const zip = await get(`/artifacts/${artifact.id}/1/archive.zip`);
    expect(zip!.status).toBe(200);
    const page = await (await get(shared))!.text();
    expect(page).toContain("archive.zip");
    expect(page).not.toContain("<iframe");
  });
});

describe("the migration to kinds", () => {
  const split = () => {
    const all = loadMigrations();
    const at = all.findIndex((m) => m.id === "0041-artifact-kind");
    return { before: all.slice(0, at), rest: all.slice(at) };
  };

  it("makes every version already published a plain site, previewed at its index.html", async () => {
    const db = await database();
    const { before, rest } = split();
    applyMigrations(db, before);
    db.exec(`
      INSERT INTO artifact (id, title, created_at, updated_at) VALUES ('a', 'Old', 1, 1);
      INSERT INTO artifact_version (id, artifact_id, number, files, bytes, size, created_at)
        VALUES ('v', 'a', 1, 1, 1, 1, 1);
    `);
    applyMigrations(db, rest);

    const { artifacts } = await bench(KINDS, db);
    expect(artifacts.view("a")!.versions[0]).toMatchObject({
      kind: "site",
      viewer: "iframe",
    });
    expect(artifacts.preview("a", 1).url).toMatch(/\/files\/index\.html$/);
  });

  it("makes the same columns on a fresh database", async () => {
    const db = await database();
    applyMigrations(db, loadMigrations());
    const columns = db
      .query<{ name: string; notnull: number; dflt_value: string }, []>(
        "PRAGMA table_info(artifact_version)",
      )
      .all()
      .filter((c) => c.name === "kind" || c.name === "manifest");
    expect(columns).toMatchObject([
      { name: "kind", notnull: 1, dflt_value: "'site'" },
      { name: "manifest", notnull: 1, dflt_value: "'{}'" },
    ]);
  });
});
