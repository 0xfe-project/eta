/**
 * Artifacts: publishing from a session through its execution environment, versions and the
 * publisher rule, the wire actions, and the pages served over HTTP with their capabilities.
 */
import type {
  ArtifactView,
  BoardTaskDetail,
  TaskCardData,
} from "@eta/client-contracts";
import type { World } from "./support/world";
import { Buffer } from "node:buffer";
import { createHmac } from "node:crypto";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { until } from "./support/client";
import { call, say, scriptedModels } from "./support/models";
import { world } from "./support/world";

type Call = ReturnType<typeof call>;

/**
 * Ada and Bob in one conversation, each making the tool calls `plans` gives them (one call per
 * model request) and then saying they are done. `play` sends a message and returns what each
 * call of the agent that answered came back with.
 */
async function room(options: Parameters<typeof world>[0] = {}) {
  const plans: Record<string, Call[]> = {};
  const seen: Record<string, string[]> = {};
  const { models } = scriptedModels((request) => {
    const who = request.agent ?? "";
    const results = (seen[who] ??= []);
    if (request.lastRole === "toolResult") results.push(request.last);
    return plans[who]?.[results.length] ?? say("done");
  });
  const w = await world({ models, ...options });
  const ada = await w.agent("Ada");
  const bob = await w.agent("Bob");
  const project = await w.project({ stewardId: ada.id });
  const group = await w.group(project.id, [ada.id, bob.id]);
  await w.watch(group.id);
  w.client.subscribe("artifacts");
  w.client.subscribe("tasks");
  const play = async (who: "Ada" | "Bob", plan: Call[]): Promise<string[]> => {
    plans[who] = plan;
    seen[who] = [];
    const agent = who === "Ada" ? ada : bob;
    const sent = await w.send(group.id, `go ${who}`, { mentions: [agent.id] });
    await Promise.all(sent.replies.map((r) => w.settled(group.id, r.id)));
    return seen[who]!;
  };
  const write = async (files: Record<string, string>) => {
    for (const [name, body] of Object.entries(files)) {
      const path = join(project.path, name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, body);
    }
  };
  return { w, ada, bob, project, group, play, write };
}

const list = (w: World) =>
  w.client.section<ArtifactView[]>("artifacts", "list") ?? [];

const publish = (args: Record<string, unknown>) =>
  call("publish_artifact", args);

describe("publish_artifact", () => {
  it("publishes a directory through the session's environment, as versions", async () => {
    const r = await room();
    await r.write({
      "dist/index.html": "<h1>hi</h1>",
      "dist/css/site.css": "h1{color:red}",
      "dist/node_modules/x/index.js": "no",
      "dist/.git/config": "no",
    });
    const [first] = await r.play("Ada", [
      publish({ path: "dist", title: "Report" }),
    ]);
    expect(first).toContain('Published "Report" version 1 (2 files)');
    await until(() => list(r.w).length === 1);
    const artifact = list(r.w)[0]!;
    expect(artifact).toMatchObject({
      title: "Report",
      publisherAgentId: r.ada.id,
      taskId: null,
      conversationId: r.group.id,
    });
    expect(artifact.versions[0]).toMatchObject({
      number: 1,
      files: 2,
      shareUrl: null,
      archiveUrl: `/artifacts/${artifact.id}/1/archive.zip`,
    });

    // The bytes: the ZIP, and the site extracted, without what is skipped.
    const base = join(r.w.host.dataDir, "artifacts", artifact.id, "1");
    expect(await readFile(join(base, "files", "css", "site.css"), "utf8")).toBe(
      "h1{color:red}",
    );
    const zip = unzipSync(
      new Uint8Array(await readFile(join(base, "archive.zip"))),
    );
    expect(Object.keys(zip).sort()).toEqual(["css/site.css", "index.html"]);

    // Again with the artifact's id: version 2, the same artifact.
    const [second] = await r.play("Ada", [
      publish({ path: "dist", title: "Report", artifactId: artifact.id }),
    ]);
    expect(second).toContain("version 2");
    await until(() => list(r.w)[0]?.versions.length === 2);
    expect(list(r.w)).toHaveLength(1);
    expect(list(r.w)[0]!.versions.map((v) => v.number)).toEqual([2, 1]);
  });

  it("lets only the agent that published an artifact add a version", async () => {
    const r = await room();
    await r.write({ "s/index.html": "x" });
    await r.play("Ada", [publish({ path: "s", title: "Mine" })]);
    await until(() => list(r.w).length === 1);
    const id = list(r.w)[0]!.id;
    const [refused] = await r.play("Bob", [
      publish({ path: "s", title: "Hers", artifactId: id }),
    ]);
    expect(refused).toMatch(/only the agent that published/);
    const [unknown] = await r.play("Bob", [
      publish({ path: "s", title: "x", artifactId: "nope" }),
    ]);
    expect(unknown).toBe("no such artifact: nope");
    expect(list(r.w)[0]).toMatchObject({ title: "Mine" });
    expect(list(r.w)[0]!.versions).toHaveLength(1);
  });

  it("refuses symlinks, a missing index.html, an oversize site, a bad path and an unknown task", async () => {
    const r = await room({ artifactLimits: { bytes: 100, files: 3 } });
    await r.write({
      "linked/index.html": "x",
      "empty/readme.txt": "x",
      "big/index.html": "x".repeat(101),
      "many/index.html": "x",
      "many/a": "1",
      "many/b": "2",
      "many/c": "3",
      "outer/inner/index.html": "x",
      "ok/index.html": "x",
      "file.txt": "x",
    });
    await symlink("/etc/hostname", join(r.project.path, "linked", "link"));
    const results = await r.play("Ada", [
      publish({ path: "linked", title: "a" }),
      publish({ path: "empty", title: "b" }),
      publish({ path: "big", title: "c" }),
      publish({ path: "many", title: "d" }),
      publish({ path: "nowhere", title: "e" }),
      publish({ path: "outer", title: "f" }),
      publish({ path: "file.txt", title: "g" }),
      publish({ path: "ok", title: "h", taskId: "99" }),
      publish({ path: "ok", title: "  " }),
    ]);
    expect(results[0]).toBe("symbolic links cannot be published: link");
    expect(results[1]).toBe("the root of the site has no index.html");
    expect(results[2]).toMatch(/at most 0\.0 MiB|at most .* MiB in all/);
    expect(results[3]).toBe("a site may have at most 3 files");
    expect(results[4]).toMatch(/cannot read nowhere/);
    expect(results[5]).toMatch(/index\.html must be at the root.*inner\//);
    expect(results[6]).toMatch(/is not a directory/);
    expect(results[7]).toBe("no such task: 99");
    expect(results[8]).toBe("an artifact needs a title");
    expect(
      r.w.host.db.query("SELECT COUNT(*) AS n FROM artifact").get(),
    ).toEqual({ n: 0 });
  });

  it("links an artifact to a task: an entry on its timeline and a line on its card", async () => {
    const r = await room();
    await r.write({ "site/index.html": "x" });
    const made = (await r.w.client.call("tasks", "create", {
      title: "Docs",
      conversationId: r.group.id,
    })) as { task: BoardTaskDetail };
    // A card needs a confirmed draft.
    const [drafted] = await r.play("Ada", [
      call("draft_task", { title: "Docs 2", goal: "g", acceptance: "a" }),
    ]);
    expect(drafted).toContain("Drafted");
    const draft = r.w.rows(r.group.id).find((m) => m.kind === "task_draft")!;
    const confirmed = (await r.w.client.call("tasks", "confirmDraft", {
      conversationId: r.group.id,
      messageId: draft.id,
    })) as { task: BoardTaskDetail };
    const number = confirmed.task.number;

    await r.play("Ada", [
      publish({ path: "site", title: "Docs site", taskId: `#${number}` }),
    ]);
    await until(
      () =>
        (r.w.row(r.group.id, draft.id)?.data as unknown as TaskCardData)
          .artifacts.length === 1,
    );
    const card = r.w.row(r.group.id, draft.id)!.data as unknown as TaskCardData;
    expect(card.artifacts[0]).toMatchObject({ title: "Docs site", version: 1 });
    expect(list(r.w)[0]).toMatchObject({ taskId: confirmed.task.id });

    const rows = r.w.host.db
      .query<{ kind: string; data: string }, [string]>(
        "SELECT kind, data FROM task_activity WHERE task_id = ? ORDER BY rowid",
      )
      .all(confirmed.task.id);
    expect(rows.map((x) => x.kind)).toEqual(["created", "artifact"]);
    expect(JSON.parse(rows[1]!.data)).toMatchObject({
      title: "Docs site",
      version: 1,
    });
    // Deleting the artifact takes it off the card again.
    await r.w.client.call("artifacts", "delete", {
      artifactId: list(r.w)[0]!.id,
    });
    await until(
      () =>
        (r.w.row(r.group.id, draft.id)?.data as unknown as TaskCardData)
          .artifacts.length === 0,
    );
    void made;
  });
});

describe("the artifacts target and its pages", () => {
  async function published() {
    const r = await room();
    await r.write({
      "site/index.html": '<link rel="stylesheet" href="css/site.css">hi',
      "site/css/site.css": "h1{}",
      "site/data/a b.json": "{}",
    });
    await r.play("Ada", [publish({ path: "site", title: "Demo" })]);
    await until(() => list(r.w).length === 1);
    const artifact = list(r.w)[0]!;
    const base = `http://127.0.0.1:${r.w.host.port}`;
    const preview = async (version = 1) =>
      (await r.w.client.call("artifacts", "preview", {
        artifactId: artifact.id,
        version,
      })) as { url: string; expiresAt: number };
    return { ...r, artifact, base, preview };
  }

  it("previews a version under a capability, in a sandbox", async () => {
    const p = await published();
    const { url, expiresAt } = await p.preview();
    expect(expiresAt).toBeGreaterThan(Date.now() + 59 * 60_000);
    expect(url).toMatch(/^\/preview\/[^/]+\/files\/index\.html$/);

    const page = await fetch(p.base + url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("hi");
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("content-security-policy")).toMatch(
      /^sandbox allow-scripts .*(?<!allow-same-origin)$/,
    );
    expect(page.headers.get("content-security-policy")).not.toContain(
      "allow-same-origin",
    );
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect(page.headers.get("access-control-allow-origin")).toBe("*");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");

    // A relative address of the page resolves under the same capability.
    const css = await fetch(new URL("css/site.css", p.base + url));
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
    expect((await fetch(new URL("data/a%20b.json", p.base + url))).status).toBe(
      200,
    );
    // A directory is its index; a missing file is missing; the way out is closed.
    expect((await fetch(p.base + url.replace("index.html", ""))).status).toBe(
      200,
    );
    expect((await fetch(new URL("nope.js", p.base + url))).status).toBe(404);
    const out = await fetch(
      p.base + url.replace("index.html", "%2e%2e/archive.zip"),
    );
    expect(out.status).toBe(404);
  });

  it("opens nothing for a capability that is altered, expired, forged or for another version", async () => {
    const p = await published();
    const good = (await p.preview()).url;
    const [id, expires, signature] = good.split("/")[2]!.split(".");
    const at = (capability: string) =>
      fetch(`${p.base}/preview/${capability}/files/index.html`);
    expect((await at(`${id}.${expires}.${signature}`)).status).toBe(200);
    // Tampered: the signature, the expiry, the version.
    expect((await at(`${id}.${expires}.${signature!.slice(1)}x`)).status).toBe(
      404,
    );
    expect((await at(`${id}.${Number(expires) + 1}.${signature}`)).status).toBe(
      404,
    );
    expect(
      (await at(`${crypto.randomUUID()}.${expires}.${signature}`)).status,
    ).toBe(404);
    expect((await at("garbage")).status).toBe(404);
    expect((await at("")).status).toBe(404);

    // Signed with the real key but already expired, and signed by a different key.
    const key = await readFile(
      join(p.w.host.dataDir, "artifacts", ".preview-key"),
    );
    const sign = (k: Buffer, expiresAt: number) =>
      `${id}.${expiresAt}.${createHmac("sha256", k).update(`${id}.${expiresAt}`).digest("base64url")}`;
    expect((await at(sign(key, Date.now() + 60_000))).status).toBe(200);
    expect((await at(sign(key, Date.now() - 1))).status).toBe(404);
    expect(
      (await at(sign(Buffer.from("other"), Date.now() + 60_000))).status,
    ).toBe(404);
    // A share token is not a capability, nor an artifact id.
    expect((await at(p.artifact.id)).status).toBe(404);
  });

  it("shares a version publicly, serves it without a capability, and takes the share back for good", async () => {
    const p = await published();
    const shared = (await p.w.client.call("artifacts", "share", {
      artifactId: p.artifact.id,
      version: 1,
    })) as { artifact: ArtifactView; url: string };
    expect(shared.url).toMatch(/^\/share\/[\w-]{43}\/$/);
    expect(shared.artifact.versions[0]!.shareUrl).toBe(shared.url);
    // Sharing again is the same page.
    const again = (await p.w.client.call("artifacts", "share", {
      artifactId: p.artifact.id,
      version: 1,
    })) as { url: string };
    expect(again.url).toBe(shared.url);
    await until(() => list(p.w)[0]?.versions[0]?.shareUrl === shared.url);

    const shell = await fetch(p.base + shared.url);
    expect(shell.status).toBe(200);
    expect(await shell.text()).toContain("Demo");
    expect(shell.headers.get("cache-control")).toBe("no-store");
    const file = await fetch(`${p.base}${shared.url}files/index.html`);
    expect(await file.text()).toContain("hi");
    expect(file.headers.get("content-security-policy")).toContain("sandbox");
    expect(file.headers.get("cache-control")).toBe("no-store");
    const archive = await fetch(`${p.base}${shared.url}archive.zip`);
    expect(archive.headers.get("content-type")).toBe("application/zip");
    expect(
      Object.keys(
        unzipSync(new Uint8Array(await archive.arrayBuffer())),
      ).sort(),
    ).toEqual(["css/site.css", "data/a b.json", "index.html"]);

    await p.w.client.call("artifacts", "unshare", {
      artifactId: p.artifact.id,
      version: 1,
    });
    for (const path of ["", "files/index.html", "archive.zip"])
      expect((await fetch(p.base + shared.url + path)).status).toBe(404);
    // Sharing again is a new address; the old one stays dead.
    const renewed = (await p.w.client.call("artifacts", "share", {
      artifactId: p.artifact.id,
      version: 1,
    })) as { url: string };
    expect(renewed.url).not.toBe(shared.url);
    expect(
      (await fetch(`${p.base}${renewed.url}files/index.html`)).status,
    ).toBe(200);
    expect((await fetch(`${p.base}${shared.url}files/index.html`)).status).toBe(
      404,
    );
    // A page under /share/ never falls through to the web, and only reads are answered.
    expect((await fetch(`${p.base}/share/nope/files/x`)).status).toBe(404);
    expect((await fetch(p.base + renewed.url, { method: "POST" })).status).toBe(
      405,
    );
  });

  it("gives the app the ZIP of a version, and keeps a new version from touching an old share", async () => {
    const p = await published();
    const shared = (await p.w.client.call("artifacts", "share", {
      artifactId: p.artifact.id,
      version: 1,
    })) as { url: string };
    await p.write({ "site/index.html": "version two" });
    await p.play("Ada", [
      publish({ path: "site", title: "Demo", artifactId: p.artifact.id }),
    ]);
    await until(() => list(p.w)[0]?.versions.length === 2);

    expect(
      await (await fetch(`${p.base}${shared.url}files/index.html`)).text(),
    ).toContain("hi");
    const v2 = await fetch(
      `${p.base}/artifacts/${p.artifact.id}/2/archive.zip`,
    );
    expect(v2.status).toBe(200);
    expect(
      new TextDecoder().decode(
        unzipSync(new Uint8Array(await v2.arrayBuffer()))["index.html"],
      ),
    ).toBe("version two");
    expect(
      (await fetch(`${p.base}/artifacts/${p.artifact.id}/3/archive.zip`))
        .status,
    ).toBe(404);
    expect((await fetch(`${p.base}/artifacts/nope/1/archive.zip`)).status).toBe(
      404,
    );
  });

  it("deletes an artifact with its files and its shares", async () => {
    const p = await published();
    const shared = (await p.w.client.call("artifacts", "share", {
      artifactId: p.artifact.id,
      version: 1,
    })) as { url: string };
    await p.w.client.call("artifacts", "delete", { artifactId: p.artifact.id });
    await until(() => list(p.w).length === 0);
    expect((await fetch(`${p.base}${shared.url}files/index.html`)).status).toBe(
      404,
    );
    await expect(
      readFile(
        join(p.w.host.dataDir, "artifacts", p.artifact.id, "1", "archive.zip"),
      ),
    ).rejects.toThrow();
    await expect(
      p.w.client.call("artifacts", "preview", {
        artifactId: p.artifact.id,
        version: 1,
      }),
    ).rejects.toThrow(/no such version/);
    await expect(
      p.w.client.call("artifacts", "delete", { artifactId: p.artifact.id }),
    ).rejects.toThrow(/no such artifact/);
  });
});
