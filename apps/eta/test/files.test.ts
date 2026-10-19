/**
 * The project's files for the composer's `@` menu: listed on the project's own machine, relative
 * to its directory, without the directories nobody means, shallow first, and capped.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./support/host";
import { remoteWorld } from "./support/remote";
import { world } from "./support/world";

async function touch(root: string, ...paths: string[]) {
  for (const path of paths) {
    const full = join(root, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, path);
  }
}

const listed = async (
  w: {
    client: { call: (t: string, a: string, args: unknown) => Promise<unknown> };
  },
  projectId: string,
  limit?: number,
) =>
  (await w.client.call("projects", "files", {
    projectId,
    ...(limit === undefined ? {} : { limit }),
  })) as { files: string[]; truncated: boolean };

describe("projects.files", () => {
  it("lists a plain directory: shallow first, no node_modules, .git or build output", async () => {
    const dir = await tempDir("eta-files-");
    await touch(
      dir,
      "README.md",
      "src/app.ts",
      "src/deep/er/file.ts",
      "node_modules/pkg/index.js",
      ".git/config",
      "dist/out.js",
      ".github/ci.yml",
      "b.txt",
    );
    const w = await world();
    const project = await w.project({ path: dir });
    const { files, truncated } = await listed(w, project.id);
    expect(truncated).toBe(false);
    expect(files).toEqual([
      "README.md",
      "b.txt",
      ".github/ci.yml",
      "src/app.ts",
      "src/deep/er/file.ts",
    ]);
  });

  it("in a git checkout is what git knows: tracked and not ignored", async () => {
    const dir = await tempDir("eta-files-git-");
    await touch(dir, "a.ts", "ignored.log", "keep/b.ts", "node_modules/x/y.js");
    await writeFile(join(dir, ".gitignore"), "*.log\nnode_modules\n");
    const init = Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
    expect(init.exitCode).toBe(0);
    const w = await world();
    const project = await w.project({ path: dir });
    const { files } = await listed(w, project.id);
    expect(files).toEqual([".gitignore", "a.ts", "keep/b.ts"]);
  });

  it("caps the list and says it was cut", async () => {
    const dir = await tempDir("eta-files-cap-");
    await touch(dir, "a", "b", "c", "d");
    const w = await world();
    const project = await w.project({ path: dir });
    expect(await listed(w, project.id, 3)).toEqual({
      files: ["a", "b", "c"],
      truncated: true,
    });
  });

  it("refuses a project that does not exist", async () => {
    const w = await world();
    await expect(listed(w, "nope")).rejects.toThrow(/no such project/);
  });

  it("is computed on the daemon's machine for a project there", async () => {
    const r = await remoteWorld();
    await touch(r.dir, "remote.txt", "lib/mod.ts", "node_modules/x/y.js");
    const { files } = await listed(r, r.remoteProject.id);
    expect(files).toEqual(["remote.txt", "lib/mod.ts"]);
  });
});
