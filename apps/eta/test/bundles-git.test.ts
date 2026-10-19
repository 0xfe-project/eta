/**
 * Bundles from git: a bare repository stands in for the remote. A branch or tag is resolved to a
 * commit and kept at it; updating is the explicit refresh; the files are fetched by the host, and
 * only the bundle's path is checked out.
 */
import { spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { filesUnder, listed } from "./support/bundles";
import { until } from "./support/client";
import { tempDir } from "./support/host";
import { world } from "./support/world";

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
  if (result.status !== 0)
    throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

/** A bare "remote" and a working copy that pushes to it. */
async function remote() {
  const bare = await tempDir("eta-remote-");
  const work = await tempDir("eta-work-");
  git(bare, "init", "-q", "--bare", "-b", "main");
  git(work, "init", "-q", "-b", "main");
  git(work, "remote", "add", "origin", bare);
  const commit = async (files: Record<string, string>, message: string) => {
    for (const [path, text] of Object.entries(files)) {
      await mkdir(join(work, path, ".."), { recursive: true });
      await writeFile(join(work, path), text);
    }
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", message);
    git(work, "push", "-q", "origin", "main");
    return git(work, "rev-parse", "HEAD");
  };
  return { bare, work, commit };
}

const manifest = (description: string) =>
  JSON.stringify({ name: "gitdemo", description });

const files = (description: string, skill = "first-skill") => ({
  "bundles/gitdemo/plugin.json": manifest(description),
  [`bundles/gitdemo/skills/${skill}/SKILL.md`]: `---\nname: ${skill}\ndescription: ${skill}\n---\n# ${skill}\n`,
  "elsewhere/other.txt": "not part of the bundle",
});

const view = (w: Awaited<ReturnType<typeof world>>) =>
  listed(w.client).find((bundle) => bundle.name === "gitdemo");

describe("a bundle from git", () => {
  it("is fetched at the commit a branch is at, only its path, and stays there until refreshed", async () => {
    const repo = await remote();
    const first = await repo.commit(files("one"), "one");
    const home = await tempDir("eta-home-");
    const w = await world({ dataDir: home });
    w.client.subscribe("bundles");

    const added = (await w.client.call("bundles", "add", {
      repo: repo.bare,
      rev: "main",
      path: "bundles/gitdemo",
    })) as { name: string };
    expect(added.name).toBe("gitdemo");
    await until(() => view(w) !== undefined);
    expect(view(w)).toMatchObject({
      description: "one",
      sha: first,
      skills: ["first-skill"],
      source: {
        kind: "git",
        repo: repo.bare,
        rev: "main",
        path: "bundles/gitdemo",
      },
      problem: null,
    });
    // The bundle's directory, not the repository: `elsewhere/` did not come.
    const kept = await filesUnder(join(home, ".eta", "bundles", "git"));
    expect(kept.some((path) => path.endsWith("plugin.json"))).toBe(true);
    expect(kept.some((path) => path.endsWith("other.txt"))).toBe(false);

    // The remote moves on; the host stays at the commit it recorded.
    const second = await repo.commit(files("two", "second-skill"), "two");
    expect(second).not.toBe(first);
    await w.client.call("bundles", "recheck", {});
    expect(view(w)).toMatchObject({ description: "one", sha: first });

    // Updating is a decision.
    const refreshed = (await w.client.call("bundles", "refresh", {})) as {
      names: string[];
    };
    expect(refreshed.names).toEqual(["gitdemo"]);
    await until(() => view(w)?.sha === second);
    expect(view(w)).toMatchObject({
      description: "two",
      skills: ["first-skill", "second-skill"],
    });
  });

  it("resolves a tag to its commit, annotated or not, and a commit as itself", async () => {
    const repo = await remote();
    const first = await repo.commit(files("one"), "one");
    git(repo.work, "tag", "-a", "v1", "-m", "release one");
    git(repo.work, "tag", "light");
    git(repo.work, "push", "-q", "origin", "v1", "light");
    await repo.commit(files("two"), "two");

    const w = await world({ dataDir: await tempDir("eta-home-") });
    w.client.subscribe("bundles");
    await w.client.call("bundles", "add", {
      repo: repo.bare,
      rev: "v1",
      path: "bundles/gitdemo",
    });
    await until(() => view(w) !== undefined);
    // The annotated tag is an object of its own; the bundle is at the commit it points to.
    expect(view(w)).toMatchObject({ sha: first, description: "one" });

    await w.client.call("bundles", "remove", { name: "gitdemo" });
    await until(() => view(w) === undefined);
    await w.client.call("bundles", "add", {
      repo: repo.bare,
      rev: "light",
      path: "bundles/gitdemo",
    });
    await until(() => view(w) !== undefined);
    expect(view(w)!.sha).toBe(first);

    await w.client.call("bundles", "remove", { name: "gitdemo" });
    await until(() => view(w) === undefined);
    await w.client.call("bundles", "add", {
      repo: repo.bare,
      rev: first,
      path: "bundles/gitdemo",
    });
    await until(() => view(w) !== undefined);
    expect(view(w)).toMatchObject({ sha: first, source: { rev: first } });
  });

  it("is fetched again at the recorded commit after a restart, whatever the remote has become", async () => {
    const repo = await remote();
    const first = await repo.commit(files("one"), "one");
    const home = await tempDir("eta-home-");
    const a = await world({ dataDir: home });
    a.client.subscribe("bundles");
    await a.client.call("bundles", "add", {
      repo: repo.bare,
      rev: "main",
      path: "bundles/gitdemo",
    });
    await until(() => view(a) !== undefined);
    await a.host.close();

    // The files are gone from disk, and the remote has moved.
    await rm(join(home, ".eta", "bundles", "git"), {
      recursive: true,
      force: true,
    });
    await repo.commit(files("two"), "two");

    const b = await world({ dataDir: home });
    b.client.subscribe("bundles");
    await until(
      () => view(b)?.problem === null && view(b)?.description === "one",
    );
    expect(view(b)!.sha).toBe(first);
  });

  it("is refused when it is not a bundle, when the name is taken, or when the address is not one", async () => {
    const repo = await remote();
    await repo.commit({ "readme.md": "nothing here" }, "readme");
    const w = await world({ dataDir: await tempDir("eta-home-") });
    await expect(
      w.client.call("bundles", "add", {
        repo: repo.bare,
        rev: "main",
        path: "",
      }),
    ).rejects.toThrow(/not a bundle/);
    await expect(
      w.client.call("bundles", "add", {
        repo: repo.bare,
        rev: "nope",
        path: "",
      }),
    ).rejects.toThrow(/no branch, tag or commit/);
    await expect(
      w.client.call("bundles", "add", { repo: "--upload-pack=x", rev: "main" }),
    ).rejects.toThrow(/repository address/);
    await expect(
      w.client.call("bundles", "add", { repo: repo.bare, path: "../x" }),
    ).rejects.toThrow(/inside the repository/);

    // A built-in bundle's name cannot be taken by a git source.
    const other = await remote();
    await other.commit(
      {
        "plugin.json": JSON.stringify({ name: "github", description: "fake" }),
      },
      "x",
    );
    await expect(
      w.client.call("bundles", "add", {
        repo: other.bare,
        rev: "main",
        path: "",
      }),
    ).rejects.toThrow(/already a bundle called github/);
    // Nothing was left behind by the refusals.
    expect(w.host.db.query("SELECT * FROM bundle_source").all()).toEqual([]);
  });

  it("carries a bundle's values away with it when it is removed", async () => {
    const repo = await remote();
    await repo.commit(
      {
        "plugin.json": JSON.stringify({
          name: "gitdemo",
          config: {
            type: "object",
            properties: { A: { type: "string", maxLength: 9 } },
          },
        }),
      },
      "x",
    );
    const w = await world({ dataDir: await tempDir("eta-home-") });
    w.client.subscribe("bundles");
    await w.client.call("bundles", "add", { repo: repo.bare, rev: "main" });
    await until(() => view(w) !== undefined);
    await w.client.call("bundles", "configure", {
      name: "gitdemo",
      values: { A: "1" },
    });
    expect(w.host.db.query("SELECT * FROM bundle_config").all()).toHaveLength(
      1,
    );
    await w.client.call("bundles", "remove", { name: "gitdemo" });
    expect(w.host.db.query("SELECT * FROM bundle_config").all()).toHaveLength(
      0,
    );
  });
});
