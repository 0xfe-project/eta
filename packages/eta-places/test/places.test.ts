/**
 * Places on a real POSIX filesystem (a temporary home), and on a Windows one kept in memory, so
 * both sets of rules are exercised wherever the tests run.
 */
import type { PlaceRunner, RunResult } from "../src";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Places, SEARCH_LIMITS } from "../src";
import { fakeFs } from "./fake-fs";

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
const missing: RunResult = { code: 127, stdout: "", stderr: "", missing: true };

/** git and gh as asked: `gh` signed in or not, or not there. */
function programs(
  options: {
    git?: boolean;
    gh?: "ready" | "signed_out" | "missing";
    repos?: unknown[];
  } = {},
) {
  const calls: string[][] = [];
  const run: PlaceRunner = async (command, args) => {
    calls.push([command, ...args]);
    if (command === "git")
      return options.git === false ? missing : ok("git version 2.45.0");
    if (command === "gh") {
      const gh = options.gh ?? "missing";
      if (gh === "missing") return missing;
      if (args[0] === "--version") return ok("gh version 2.60.0");
      if (args[0] === "auth")
        return gh === "ready"
          ? ok()
          : {
              code: 1,
              stdout: "",
              stderr: "You are not logged into any GitHub hosts.",
            };
      return ok(JSON.stringify(options.repos ?? []));
    }
    return missing;
  };
  return { run, calls };
}

const made: string[] = [];
afterEach(async () => {
  for (const dir of made.splice(0))
    await rm(dir, { recursive: true, force: true });
});

async function home(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "eta-places-")));
  made.push(dir);
  return dir;
}

const dirs = async (root: string, paths: string[]) => {
  for (const path of paths) await mkdir(join(root, path), { recursive: true });
};

describe("list", () => {
  it("lists directories only, marks hidden and git ones, and gives crumbs and display paths", async () => {
    const at = await home();
    await dirs(at, [
      "Developer/eta/.git",
      "Developer/notes",
      "Developer/.cache",
      "Developer/node_modules",
    ]);
    await writeFile(join(at, "Developer/readme.txt"), "x");
    const places = new Places({ home: at, os: "linux", run: programs().run });
    const listing = await places.list("~/Developer");
    expect(listing.path).toBe(join(at, "Developer"));
    expect(listing.display).toBe("~/Developer");
    expect(listing.crumbs).toEqual([
      { name: "~", path: at },
      { name: "Developer", path: join(at, "Developer") },
    ]);
    expect(listing.parent).toEqual({ path: at, display: "~" });
    expect(listing.drives).toEqual([]);
    expect(
      listing.entries.map((e) => [e.name, e.hidden, e.git, e.display]),
    ).toEqual([
      [".cache", true, false, "~/Developer/.cache"],
      ["eta", false, true, "~/Developer/eta"],
      ["node_modules", false, false, "~/Developer/node_modules"],
      ["notes", false, false, "~/Developer/notes"],
    ]);
    expect(JSON.stringify(listing)).not.toContain("readme");
  });

  it("starts at the home, and says why it cannot list", async () => {
    const at = await home();
    await writeFile(join(at, "file"), "x");
    const places = new Places({ home: at, os: "linux", run: programs().run });
    expect((await places.list()).path).toBe(at);
    await expect(places.list("~/nope")).rejects.toMatchObject({
      failure: { code: "not_found" },
    });
    await expect(places.list("~/file")).rejects.toMatchObject({
      failure: { code: "not_directory" },
    });
    await expect(places.list("relative")).rejects.toMatchObject({
      failure: { code: "not_absolute" },
    });
    await expect(places.list("C:\\Users")).rejects.toMatchObject({
      failure: { code: "invalid" },
    });
  });

  it("on Windows: backslashes, every drive, junctions and system folders hidden", async () => {
    const fs = fakeFs(
      "win32",
      [
        "C:\\Users\\Ada\\code\\eta\\.git",
        "C:\\Users\\Ada\\AppData\\Local",
        "C:\\Users\\Ada\\Documents",
        "D:\\work",
      ],
      {
        links: { "C:\\Users\\Ada\\My Documents": "C:\\Users\\Ada\\Documents" },
      },
    );
    const places = new Places({
      home: "C:\\Users\\Ada",
      os: "win32",
      fs,
      run: programs().run,
    });
    const listing = await places.list("~");
    expect(listing.path).toBe("C:\\Users\\Ada");
    expect(listing.display).toBe("~");
    expect(listing.drives).toEqual(["C:\\", "D:\\"]);
    expect(listing.entries.map((e) => [e.name, e.hidden])).toEqual([
      ["AppData", true],
      ["code", false],
      ["Documents", false],
      ["My Documents", true],
    ]);
    const code = await places.list("c:/users/ada/code");
    expect(code.entries).toMatchObject([
      {
        name: "eta",
        git: true,
        display: "~\\code\\eta",
        path: "c:\\users\\ada\\code\\eta",
      },
    ]);
    const drive = await places.list("D:");
    expect(drive).toMatchObject({
      path: "D:\\",
      parent: null,
      crumbs: [{ name: "D:", path: "D:\\" }],
    });
    await expect(places.list("/home/ada")).rejects.toMatchObject({
      failure: { code: "invalid" },
    });
  });
});

describe("search", () => {
  it("finds directories by name under the home, the name's match first", async () => {
    const at = await home();
    await dirs(at, [
      "Developer/eta/apps/web",
      "Developer/eta-web-old",
      "src/etaweb/.git",
      "Developer/website",
    ]);
    const places = new Places({ home: at, os: "linux", run: programs().run });
    const found = await places.search("eta");
    expect(found.matches.map((m) => m.display).slice(0, 3)).toEqual([
      "~/Developer/eta",
      "~/Developer/eta-web-old",
      "~/src/etaweb",
    ]);
    expect(found.matches.find((m) => m.display === "~/src/etaweb")?.git).toBe(
      true,
    );
    // Across the path when the name alone does not match.
    expect(
      (await places.search("eta web")).matches.map((m) => m.display),
    ).toContain("~/Developer/eta/apps/web");
    expect((await places.search("")).matches).toEqual([]);
  });

  it("skips node_modules, .git, hidden directories and links, and keeps to its depth", async () => {
    const at = await home();
    await dirs(at, [
      "a/node_modules/target-x",
      "a/.git/target-y",
      ".hidden/target-z",
      "a/b/c/d/e/f/g/target-deep",
      "a/target-ok",
    ]);
    const places = new Places({ home: at, os: "linux", run: programs().run });
    const names = (await places.search("target")).matches.map((m) => m.name);
    expect(names).toEqual(["target-ok"]);
    expect(SEARCH_LIMITS.maxDepth).toBeLessThan(8);
  });

  it("returns at most what it is asked for, and says it stopped", async () => {
    const at = await home();
    await dirs(
      at,
      Array.from(
        { length: 12 },
        (_, i) => `proj-${String(i).padStart(2, "0")}`,
      ),
    );
    const places = new Places({ home: at, os: "linux", run: programs().run });
    const found = await places.search("proj", 5);
    expect(found.matches).toHaveLength(5);
    expect(found.truncated).toBe(true);
    expect((await places.search("proj", 500)).matches).toHaveLength(12);
  });

  it("reuses a directory's listing for a moment", async () => {
    const at = await home();
    await dirs(at, ["one"]);
    let now = 1_000;
    const places = new Places({
      home: at,
      os: "linux",
      run: programs().run,
      now: () => now,
    });
    expect((await places.search("two")).matches).toEqual([]);
    await dirs(at, ["two"]);
    expect((await places.search("two")).matches).toEqual([]);
    now += SEARCH_LIMITS.cacheMs + 1;
    expect((await places.search("two")).matches.map((m) => m.name)).toEqual([
      "two",
    ]);
  });

  it("a typed path lists inside it, hidden ones too", async () => {
    const at = await home();
    await dirs(at, ["Developer/new-thing", "Developer/newer", ".config/app"]);
    const places = new Places({ home: at, os: "linux", run: programs().run });
    expect(
      (await places.search("~/Developer/new")).matches.map((m) => m.display),
    ).toEqual(["~/Developer/new-thing", "~/Developer/newer"]);
    expect(
      (await places.search("~/.config")).matches.map((m) => m.display),
    ).toEqual(["~/.config"]);
    expect(
      (await places.search("~/.co")).matches.map((m) => m.display),
    ).toEqual(["~/.config"]);
    expect(
      (await places.search(`${at}/Developer/`)).matches.map((m) => m.display),
    ).toEqual(["~/Developer", "~/Developer/new-thing", "~/Developer/newer"]);
  });

  it("on Windows, a drive path is typed and the home is walked with backslashes", async () => {
    const fs = fakeFs("win32", [
      "C:\\Users\\Ada\\code\\eta",
      "C:\\Users\\Ada\\AppData\\eta-cache",
      "D:\\eta-data",
    ]);
    const places = new Places({
      home: "C:\\Users\\Ada",
      os: "win32",
      fs,
      run: programs().run,
    });
    expect((await places.search("eta")).matches.map((m) => m.display)).toEqual([
      "~\\code\\eta",
    ]);
    expect((await places.search("D:\\et")).matches.map((m) => m.path)).toEqual([
      "D:\\eta-data",
    ]);
    expect((await places.search("d:/")).matches.map((m) => m.path)).toEqual([
      "d:\\",
      "d:\\eta-data",
    ]);
    // A POSIX path on Windows is a name to look for, not a place.
    expect((await places.search("/eta")).matches.map((m) => m.display)).toEqual(
      ["~\\code\\eta"],
    );
  });
});

describe("mkdir", () => {
  it("makes one directory in a parent that is there", async () => {
    const at = await home();
    const places = new Places({ home: at, os: "linux", run: programs().run });
    expect(await places.mkdir("~", "fresh")).toEqual({
      path: join(at, "fresh"),
      display: "~/fresh",
    });
    expect((await places.list("~/fresh")).entries).toEqual([]);
    await expect(places.mkdir("~", "fresh")).rejects.toMatchObject({
      failure: { code: "exists" },
    });
    await expect(places.mkdir("~/missing", "x")).rejects.toMatchObject({
      failure: { code: "not_found" },
    });
    await expect(places.mkdir("~", "a/b")).rejects.toMatchObject({
      failure: { code: "invalid" },
    });
    await expect(places.mkdir("~", "..")).rejects.toMatchObject({
      failure: { code: "invalid" },
    });
  });

  it("on Windows: a drive parent, and the names Windows refuses", async () => {
    const fs = fakeFs("win32", ["C:\\Users\\Ada", "D:\\work"]);
    const places = new Places({
      home: "C:\\Users\\Ada",
      os: "win32",
      fs,
      run: programs().run,
    });
    expect(await places.mkdir("D:/work", "eta")).toEqual({
      path: "D:\\work\\eta",
      display: "D:\\work\\eta",
    });
    expect(await places.mkdir("~", "proj")).toEqual({
      path: "C:\\Users\\Ada\\proj",
      display: "~\\proj",
    });
    await expect(places.mkdir("~", "con")).rejects.toMatchObject({
      failure: { code: "invalid" },
    });
    await expect(places.mkdir("~", "a\\b")).rejects.toMatchObject({
      failure: { code: "invalid" },
    });
  });
});

describe("resolve", () => {
  it("says what is there, by the machine's rules", async () => {
    const at = await home();
    await writeFile(join(at, "f"), "x");
    const places = new Places({ home: at, os: "linux", run: programs().run });
    expect(await places.resolve("~/")).toEqual({
      path: at,
      display: "~",
      exists: true,
      directory: true,
    });
    expect(await places.resolve("~/f")).toMatchObject({
      exists: true,
      directory: false,
    });
    expect(await places.resolve("~/none")).toMatchObject({ exists: false });
    const fs = fakeFs("win32", ["C:\\Users\\Ada\\code"]);
    const win = new Places({
      home: "C:\\Users\\Ada",
      os: "win32",
      fs,
      run: programs().run,
    });
    expect(await win.resolve("C:/Users/Ada/code/")).toEqual({
      path: "C:\\Users\\Ada\\code",
      display: "~\\code",
      exists: true,
      directory: true,
    });
    await expect(win.resolve("/home/ada")).rejects.toMatchObject({
      failure: { code: "invalid" },
    });
  });
});

describe("capabilities and repositories", () => {
  it("says whether git is there and whether gh is signed in, and remembers for a while", async () => {
    const at = await home();
    const ready = programs({ gh: "ready" });
    let now = 0;
    const places = new Places({
      home: at,
      os: "linux",
      run: ready.run,
      now: () => now,
    });
    expect(await places.capabilities()).toEqual({
      flavor: "posix",
      home: at,
      git: true,
      gh: "ready",
      mkdir: true,
    });
    await places.capabilities();
    expect(ready.calls.filter(([c]) => c === "git")).toHaveLength(1);
    now = 60_000;
    await places.capabilities();
    expect(ready.calls.filter(([c]) => c === "git")).toHaveLength(2);
    expect(
      await new Places({
        home: at,
        os: "linux",
        run: programs({ git: false, gh: "signed_out" }).run,
      }).capabilities(),
    ).toMatchObject({ git: false, gh: "signed_out" });
    expect(
      await new Places({
        home: at,
        os: "linux",
        run: programs().run,
      }).capabilities(),
    ).toMatchObject({ gh: "missing" });
  });

  it("searches repositories with gh when signed in, and only offers pasting when not", async () => {
    const at = await home();
    const ready = programs({
      gh: "ready",
      repos: [
        {
          fullName: "0xfe-project/eta",
          description: "",
          updatedAt: "2026-11-18T00:00:00Z",
          url: "https://github.com/0xfe-project/eta",
        },
      ],
    });
    const places = new Places({ home: at, os: "linux", run: ready.run });
    expect(await places.repos("eta")).toEqual({
      available: true,
      repos: [
        {
          id: "gh:0xfe-project/eta",
          nameWithOwner: "0xfe-project/eta",
          cloneUrl: "0xfe-project/eta",
          description: null,
          updatedAt: "2026-11-18T00:00:00Z",
        },
      ],
    });
    expect(ready.calls.at(-1)?.slice(0, 4)).toEqual([
      "gh",
      "search",
      "repos",
      "eta",
    ]);
    await places.repos("");
    expect(ready.calls.at(-1)?.slice(0, 3)).toEqual(["gh", "repo", "list"]);
    const out = new Places({
      home: at,
      os: "linux",
      run: programs({ gh: "signed_out" }).run,
    });
    expect(await out.repos("eta")).toEqual({
      available: false,
      reason: "gh_signed_out",
    });
  });
});

describe("serve", () => {
  it("answers an op with its value, or its failure's code, never a throw", async () => {
    const at = await home();
    const places = new Places({ home: at, os: "linux", run: programs().run });
    expect(await places.serve({ op: "resolve", path: "~" })).toMatchObject({
      ok: true,
      value: { path: at },
    });
    expect(await places.serve({ op: "list", path: "nowhere" })).toEqual({
      ok: false,
      failure: { code: "not_absolute" },
    });
    expect(await places.serve({ op: "teleport" } as never)).toMatchObject({
      ok: false,
      failure: { code: "unsupported" },
    });
  });
});
