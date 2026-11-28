/**
 * The project's files for the composer's `@` menu: listed on the project's own machine, relative
 * to its directory, without the directories nobody means, shallow first, and capped.
 */
import type { ProjectResults } from "@eta/client-contracts";
import { Buffer } from "node:buffer";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_PREVIEW_BYTES } from "../src/projects/files";
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

interface Caller {
  client: { call: (t: string, a: string, args: unknown) => Promise<unknown> };
}

const directory = async (
  w: Caller,
  projectId: string,
  path?: string,
  limit?: number,
) =>
  (await w.client.call("projects", "directory", {
    projectId,
    ...(path === undefined ? {} : { path }),
    ...(limit === undefined ? {} : { limit }),
  })) as ProjectResults["directory"];

const readFile = async (w: Caller, projectId: string, path: string) =>
  (await w.client.call("projects", "readFile", {
    projectId,
    path,
  })) as ProjectResults["readFile"];

describe("projects.directory", () => {
  it("lists directories before files, skips .git, and marks dotfiles hidden", async () => {
    const dir = await tempDir("eta-dir-");
    await touch(
      dir,
      "README.md",
      "src/app.ts",
      ".github/ci.yml",
      ".gitignore",
      ".git/HEAD",
      "notes with space.txt",
      "docs/中文.md",
    );
    const w = await world();
    const project = await w.project({ path: dir });

    const root = await directory(w, project.id);
    expect(root.path).toBe("");
    expect(root.truncated).toBe(false);
    expect(root.entries).toEqual([
      { name: ".github", path: ".github", kind: "directory", hidden: true },
      { name: "docs", path: "docs", kind: "directory" },
      { name: "src", path: "src", kind: "directory" },
      { name: ".gitignore", path: ".gitignore", kind: "file", hidden: true },
      {
        name: "notes with space.txt",
        path: "notes with space.txt",
        kind: "file",
      },
      { name: "README.md", path: "README.md", kind: "file" },
    ]);

    const sub = await directory(w, project.id, "docs");
    expect(sub).toEqual({
      path: "docs",
      truncated: false,
      entries: [{ name: "中文.md", path: "docs/中文.md", kind: "file" }],
    });
  });

  it("caps entries at limit and marks truncated", async () => {
    const dir = await tempDir("eta-dir-cap-");
    await touch(dir, "a.ts", "b.ts", "c.ts", "d.ts");
    const w = await world();
    const project = await w.project({ path: dir });
    const res = await directory(w, project.id, "", 2);
    expect(res.truncated).toBe(true);
    expect(res.entries.map((entry) => entry.name)).toEqual(["a.ts", "b.ts"]);
  });

  it("refuses path traversal and symlinks pointing outside the project", async () => {
    const dir = await tempDir("eta-dir-sec-");
    const outside = await tempDir("eta-dir-outside-");
    await touch(outside, "secret.txt");
    // A junction needs no privilege on Windows; on other systems it is a plain directory link.
    await symlink(outside, join(dir, "escape-dir"), "junction");
    const w = await world();
    const project = await w.project({ path: dir });

    await expect(directory(w, project.id, "../outside")).rejects.toThrow(
      /invalid project path/,
    );
    await expect(directory(w, project.id, "/etc")).rejects.toThrow(
      /invalid project path/,
    );
    await expect(directory(w, project.id, "escape-dir")).rejects.toThrow(
      /outside the project/,
    );
  });

  it("lists directories on a remote daemon machine", async () => {
    const r = await remoteWorld();
    await touch(r.dir, "README.md", "pkg/index.ts");
    const root = await directory(r, r.remoteProject.id);
    expect(root.entries).toEqual([
      { name: "pkg", path: "pkg", kind: "directory" },
      { name: "README.md", path: "README.md", kind: "file" },
    ]);
    const pkg = await directory(r, r.remoteProject.id, "pkg");
    expect(pkg.entries).toEqual([
      { name: "index.ts", path: "pkg/index.ts", kind: "file" },
    ]);
  });
});

describe("projects.readFile", () => {
  it("reads text files including empty files and unicode paths", async () => {
    const dir = await tempDir("eta-read-");
    await mkdir(join(dir, "docs"), { recursive: true });
    await writeFile(join(dir, "docs", "说明.md"), "# 你好\nhello/world\n");
    await writeFile(join(dir, "empty.txt"), "");
    const w = await world();
    const project = await w.project({ path: dir });

    const doc = await readFile(w, project.id, "docs/说明.md");
    expect(doc).toEqual({
      kind: "text",
      path: "docs/说明.md",
      text: "# 你好\nhello/world\n",
      size: Buffer.byteLength("# 你好\nhello/world\n", "utf8"),
      truncated: false,
    });

    const empty = await readFile(w, project.id, "empty.txt");
    expect(empty).toEqual({
      kind: "text",
      path: "empty.txt",
      text: "",
      size: 0,
      truncated: false,
    });
  });

  it("truncates large text files cleanly even when a multi-byte UTF-8 character straddles the boundary", async () => {
    const dir = await tempDir("eta-read-large-");
    // Place a 3-byte UTF-8 character right across MAX_PREVIEW_BYTES.
    const prefix = "a".repeat(MAX_PREVIEW_BYTES - 1);
    const full = `${prefix}中tail`;
    await writeFile(join(dir, "big.txt"), full, "utf8");
    const w = await world();
    const project = await w.project({ path: dir });

    const res = await readFile(w, project.id, "big.txt");
    expect(res.kind).toBe("text");
    if (res.kind === "text") {
      expect(res.truncated).toBe(true);
      expect(res.size).toBe(Buffer.byteLength(full, "utf8"));
      expect(res.text).toBe(prefix);
    }
  });

  it("reports binary files without throwing", async () => {
    const dir = await tempDir("eta-read-bin-");
    await writeFile(
      join(dir, "sample.bin"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]),
    );
    const w = await world();
    const project = await w.project({ path: dir });
    expect(await readFile(w, project.id, "sample.bin")).toEqual({
      kind: "binary",
      path: "sample.bin",
      size: 7,
      reason: "binary",
    });
  });

  it("refuses directories, missing files, path traversal, and escaping directory links", async () => {
    const dir = await tempDir("eta-read-sec-");
    const outside = await tempDir("eta-read-out-");
    await writeFile(join(outside, "secret.txt"), "top-secret");
    await mkdir(join(dir, "sub"), { recursive: true });
    await symlink(outside, join(dir, "escape-dir"), "junction");
    const w = await world();
    const project = await w.project({ path: dir });

    await expect(readFile(w, project.id, "sub")).rejects.toThrow(
      /not a regular file/,
    );
    await expect(readFile(w, project.id, "missing.txt")).rejects.toThrow(
      /no such file/,
    );
    await expect(readFile(w, project.id, "../secret.txt")).rejects.toThrow(
      /invalid project path/,
    );
    await expect(
      readFile(w, project.id, "escape-dir/secret.txt"),
    ).rejects.toThrow(/outside the project/);
  });

  it("refuses a file symlink pointing outside the project, where the system allows one", async () => {
    const dir = await tempDir("eta-read-link-");
    const outside = await tempDir("eta-read-link-out-");
    await writeFile(join(outside, "secret.txt"), "top-secret");
    try {
      await symlink(
        join(outside, "secret.txt"),
        join(dir, "escape.txt"),
        "file",
      );
    } catch {
      return; // Windows without developer mode / symlink privilege
    }
    const w = await world();
    const project = await w.project({ path: dir });
    await expect(readFile(w, project.id, "escape.txt")).rejects.toThrow(
      /outside the project/,
    );
  });

  it("reads files from a remote daemon machine", async () => {
    const r = await remoteWorld();
    await mkdir(join(r.dir, "src"), { recursive: true });
    await writeFile(join(r.dir, "src", "main.ts"), "export const ok = true;\n");
    const res = await readFile(r, r.remoteProject.id, "src/main.ts");
    expect(res).toEqual({
      kind: "text",
      path: "src/main.ts",
      text: "export const ok = true;\n",
      size: 24,
      truncated: false,
    });
  });
});
