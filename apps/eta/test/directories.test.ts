/**
 * Choosing a directory to add: what a machine has in a directory, as names and marks and nothing
 * else, and why when it cannot say.
 */
import type { DirectoryEntry, ProjectResults } from "@eta/client-contracts";
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { connect } from "./support/client";
import { tempDir, testHost } from "./support/host";
import { remoteWorld } from "./support/remote";
import { world } from "./support/world";

type Listing = ProjectResults["directories"];
interface Caller {
  client: { call: (t: string, a: string, args: unknown) => Promise<unknown> };
}

const listed = async (w: Caller, path?: string, machineId?: string) =>
  (await w.client.call("projects", "directories", {
    ...(path === undefined ? {} : { path }),
    ...(machineId === undefined ? {} : { machineId }),
  })) as Listing;

const problem = async (w: Caller, path: string, machineId?: string) =>
  (await listed(w, path, machineId).then(
    () => undefined,
    (error: { problem?: { code: string } }) => error.problem?.code,
  )) as string | undefined;

const names = (entries: DirectoryEntry[]) => entries.map((entry) => entry.name);

/** A directory that nobody may read; put back afterwards, or the temp directory cannot go. */
const locked: string[] = [];
afterEach(async () => {
  for (const path of locked.splice(0)) await chmod(path, 0o755);
});
const lock = async (path: string, mode: number) => {
  await chmod(path, mode);
  locked.push(path);
};
const root = process.getuid?.() === 0;

describe("projects.directories", () => {
  it("lists only directories, by name, and a link to a directory is one", async () => {
    const dir = await tempDir("eta-dirs-");
    await mkdir(join(dir, "zeta"));
    await mkdir(join(dir, "Alpha"));
    await mkdir(join(dir, "with space"));
    await writeFile(join(dir, "notes.txt"), "secret");
    await writeFile(join(dir, "Beta.md"), "secret");
    await symlink(join(dir, "zeta"), join(dir, "link-to-dir"));
    await symlink(join(dir, "notes.txt"), join(dir, "link-to-file"));
    await symlink(join(dir, "gone"), join(dir, "broken"));
    const w = await world();
    const listing = await listed(w, dir);
    expect(names(listing.entries)).toEqual([
      "Alpha",
      "link-to-dir",
      "with space",
      "zeta",
    ]);
    // Nothing about a file crosses the wire, not even that it is there.
    const raw = JSON.stringify(listing);
    expect(raw).not.toContain("notes.txt");
    expect(raw).not.toContain("Beta");
    expect(raw).not.toContain("link-to-file");
    expect(listing).toMatchObject({
      path: dir,
      parent: dirname(dir),
      truncated: false,
    });
  });

  it("starts at the machine's home, which `~` also means", async () => {
    const w = await world();
    const home = await listed(w);
    expect(home.home).toBe(homedir());
    expect(home.path).toBe(homedir());
    expect((await listed(w, "~")).path).toBe(homedir());
    const dir = await tempDir("eta-dirs-");
    await expect(listed(w, dir)).resolves.toMatchObject({ home: homedir() });
  });

  it("normalizes a path by its text, keeping a link's own name", async () => {
    const dir = await tempDir("eta-dirs-");
    await mkdir(join(dir, "real/inner"), { recursive: true });
    await symlink(join(dir, "real"), join(dir, "alias"));
    const w = await world();
    expect((await listed(w, `${dir}//real/./inner/..//`)).path).toBe(
      join(dir, "real"),
    );
    expect((await listed(w, join(dir, "alias"))).path).toBe(join(dir, "alias"));
    const top = await listed(w, "/");
    expect(top).toMatchObject({ path: "/", parent: null });
  });

  it("marks dot directories as hidden and repositories as git", async () => {
    const dir = await tempDir("eta-dirs-");
    await mkdir(join(dir, ".config"));
    await mkdir(join(dir, "..odd"));
    await mkdir(join(dir, "repo/.git"), { recursive: true });
    await mkdir(join(dir, "worktree"));
    await writeFile(join(dir, "worktree/.git"), "gitdir: elsewhere");
    await mkdir(join(dir, "plain"));
    const w = await world();
    const { entries } = await listed(w, dir);
    expect(entries).toEqual([
      { name: "..odd", hidden: true, git: false, projectId: null },
      { name: ".config", hidden: true, git: false, projectId: null },
      { name: "plain", hidden: false, git: false, projectId: null },
      { name: "repo", hidden: false, git: true, projectId: null },
      { name: "worktree", hidden: false, git: true, projectId: null },
    ]);
  });

  it("says which directories are already projects", async () => {
    const dir = await tempDir("eta-dirs-");
    await mkdir(join(dir, "added"));
    await mkdir(join(dir, "other"));
    const w = await world();
    const project = await w.project({ path: join(dir, "added") });
    const { entries } = await listed(w, dir);
    expect(entries).toMatchObject([
      { name: "added", projectId: project.id },
      { name: "other", projectId: null },
    ]);
  });

  it("caps the list, says so, and keeps what is shown by default", async () => {
    const dir = await tempDir("eta-dirs-");
    await mkdir(join(dir, ".hidden"));
    for (let index = 0; index < 1001; index += 1)
      await mkdir(join(dir, `d${String(index).padStart(4, "0")}`));
    const w = await world();
    const { entries, truncated } = await listed(w, dir);
    expect(entries).toHaveLength(1000);
    expect(truncated).toBe(true);
    expect(entries.some((entry) => entry.hidden)).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "calls a name that holds a newline one directory",
    async () => {
      const dir = await tempDir("eta-dirs-");
      await mkdir(join(dir, "two\nlines"));
      const w = await world();
      expect(names((await listed(w, dir)).entries)).toEqual(["two\nlines"]);
    },
  );

  it("is an empty list for an empty directory, not a failure", async () => {
    const w = await world();
    const { entries } = await listed(w, await tempDir("eta-dirs-"));
    expect(entries).toEqual([]);
  });

  it("tells a missing path from an unusable one, and says no more", async () => {
    const dir = await tempDir("eta-dirs-");
    await writeFile(join(dir, "file"), "x");
    const w = await world();
    expect(await problem(w, join(dir, "nope"))).toBe("not_found");
    expect(await problem(w, join(dir, "file"))).toBe("not_found");
    expect(await problem(w, "relative/path")).toBe("not_found");
    const failure = await listed(w, join(dir, "nope")).catch(
      (error: Error) => error,
    );
    expect((failure as Error).message).not.toContain(dir);
  });

  it.skipIf(root || process.platform === "win32")(
    "calls a directory it may not read denied",
    async () => {
      const dir = await tempDir("eta-dirs-");
      await mkdir(join(dir, "closed/inside"), { recursive: true });
      await mkdir(join(dir, "unlistable"));
      await lock(join(dir, "closed"), 0o000);
      await lock(join(dir, "unlistable"), 0o311);
      const w = await world();
      expect(await problem(w, join(dir, "closed"))).toBe("denied");
      // What is behind it may be there or not: only that it cannot be looked at is known.
      expect(await problem(w, join(dir, "closed/inside"))).toBe("denied");
      expect(await problem(w, join(dir, "unlistable"))).toBe("denied");
    },
  );

  it("refuses a machine that does not exist", async () => {
    const w = await world();
    await expect(listed(w, "/", "nope")).rejects.toThrow(/no such machine/);
  });

  it("is listed by the daemon's machine for a machine there", async () => {
    const r = await remoteWorld();
    await mkdir(join(r.dir, "src"));
    await mkdir(join(r.dir, "repo/.git"), { recursive: true });
    await mkdir(join(r.dir, ".cache"));
    await writeFile(join(r.dir, "file.txt"), "x");
    const inner = await r.project({
      path: join(r.dir, "src"),
      machineId: r.daemon.machineId,
    });
    const { entries } = await listed(r, r.dir, r.daemon.machineId);
    expect(entries).toEqual([
      { name: ".cache", hidden: true, git: false, projectId: null },
      { name: "repo", hidden: false, git: true, projectId: null },
      { name: "src", hidden: false, git: false, projectId: inner.id },
    ]);
    expect(await problem(r, join(r.dir, "nope"), r.daemon.machineId)).toBe(
      "not_found",
    );
  });

  it("says offline for a machine that is not connected", async () => {
    const r = await remoteWorld();
    await r.daemon.stop();
    expect(await problem(r, r.dir, r.daemon.machineId)).toBe("offline");
  });
});

describe("projects.directories behind the token", () => {
  const TOKEN = "t".repeat(32);

  it("cannot be reached without it", async () => {
    const dir = await tempDir("eta-dirs-");
    const tokenFile = join(dir, "token");
    await writeFile(tokenFile, TOKEN);
    const host = await testHost({ tokenFile });
    const url = `ws://127.0.0.1:${host.port}/ws`;
    await expect(connect(url)).rejects.toBeDefined();
    const client = await connect(url, { authorization: `Bearer ${TOKEN}` });
    await expect(
      client.call("projects", "directories", { path: dir }),
    ).resolves.toMatchObject({ path: dir });
    client.close();
  });
});
