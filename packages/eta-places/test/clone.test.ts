/**
 * Cloning: git's progress as it comes, a stop that leaves nothing behind, and a failure that says
 * which of the usual troubles it was. `simple-git` runs a scripted git program for the troubles,
 * and a real git against a local repository for the clone itself.
 */
import type { PlaceRunner, RunResult } from "../src";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { classifyCloneFailure, Places } from "../src";
import { fakeFs } from "./fake-fs";

const exec = promisify(execFile);

const made: string[] = [];
afterEach(async () => {
  delete process.env.FAKE_GIT_MODE;
  for (const dir of made.splice(0))
    await rm(dir, { recursive: true, force: true });
});

async function home(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "eta-clone-")));
  made.push(dir);
  return dir;
}

/**
 * A git program that logs its arguments and environment, then acts as `FAKE_GIT_MODE` says:
 * by default it writes git's progress lines and makes the target, `hang` waits to be stopped,
 * `auth` fails the way an unauthenticated HTTPS clone does.
 */
async function fakeGit(dir: string): Promise<{ binary: string; log: string }> {
  const binary = join(dir, "fake-git");
  const log = join(dir, "git.log");
  await writeFile(
    binary,
    `#!/bin/sh
printf '%s\\n' "$@" > "${log}"
printf 'PROMPT=%s\\n' "$GIT_TERMINAL_PROMPT" >> "${log}"
eval target=\\$$#
case "$FAKE_GIT_MODE" in
  hang) printf 'Receiving objects:   5%% (1/20)\\r' >&2; mkdir -p "$target"; exec sleep 30 ;;
  auth) echo "fatal: Authentication failed for 'https://github.com/a/b.git/'" >&2; exit 128 ;;
  *) printf 'Cloning into %s...\\n' "$target" >&2; sleep 0.1
     printf 'Receiving objects:  10%% (1/10)\\r' >&2; sleep 0.1
     printf 'Receiving objects: 100%% (10/10)\\n' >&2; sleep 0.1
     printf 'Resolving deltas:  50%% (1/2)\\r' >&2
     mkdir -p "$target" ;;
esac
`,
  );
  await chmod(binary, 0o755);
  return { binary, log };
}

/** gh as asked: signed in and set to clone over `protocol`, or not there. */
function gh(protocol?: "ssh" | "https"): PlaceRunner {
  return async (command, args): Promise<RunResult> => {
    if (command === "git")
      return { code: 0, stdout: "git version 2", stderr: "" };
    if (protocol === undefined)
      return { code: 127, stdout: "", stderr: "", missing: true };
    if (args[0] === "config")
      return { code: 0, stdout: `${protocol}\n`, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
}

describe("git's progress", () => {
  it("reaches the caller as git writes it, and nothing asks a question", async () => {
    const at = await home();
    const { binary, log } = await fakeGit(at);
    const places = new Places({
      home: at,
      os: "linux",
      run: gh(),
      git: binary,
    });
    const events: unknown[] = [];
    const done = await places.clone(
      {
        op: "clone",
        url: "https://github.com/octocat/Hello-World.git",
        target: "~/Hello-World",
      },
      { onProgress: (event) => events.push(event) },
    );
    expect(done).toEqual({
      path: join(at, "Hello-World"),
      display: "~/Hello-World",
    });
    expect(events).toContainEqual({ phase: "receiving", percent: 10 });
    expect(events).toContainEqual({ phase: "receiving", percent: 100 });
    const args = await readFile(log, "utf8");
    expect(args).toContain("clone");
    expect(args).toContain("https://github.com/octocat/Hello-World.git");
    expect(args).toContain("PROMPT=0");
  });
});

describe("what is cloned, and how", () => {
  it("takes owner/repo by HTTPS or SSH, and gh's protocol and login when gh found it", async () => {
    const at = await home();
    const { binary, log } = await fakeGit(at);
    const typed = new Places({ home: at, os: "linux", run: gh(), git: binary });
    await typed.clone({
      op: "clone",
      url: "octocat/Spoon-Knife",
      protocol: "ssh",
      target: "~/a",
    });
    expect(await readFile(log, "utf8")).toContain(
      "git@github.com:octocat/Spoon-Knife.git",
    );
    await typed.clone({
      op: "clone",
      url: "octocat/Spoon-Knife",
      protocol: "https",
      target: "~/b",
    });
    expect(await readFile(log, "utf8")).toContain(
      "https://github.com/octocat/Spoon-Knife.git",
    );
    const viaGh = new Places({
      home: at,
      os: "linux",
      run: gh("https"),
      git: binary,
    });
    await viaGh.clone({
      op: "clone",
      url: "octocat/Spoon-Knife",
      target: "~/c",
    });
    const asked = await readFile(log, "utf8");
    expect(asked).toContain("https://github.com/octocat/Spoon-Knife.git");
    expect(asked).toContain("credential.helper=!gh auth git-credential");
    const viaGhSsh = new Places({
      home: at,
      os: "linux",
      run: gh("ssh"),
      git: binary,
    });
    await viaGhSsh.clone({
      op: "clone",
      url: "octocat/Spoon-Knife",
      target: "~/d",
    });
    expect(await readFile(log, "utf8")).toContain(
      "git@github.com:octocat/Spoon-Knife.git",
    );
  });

  it("refuses an option dressed as a URL, words that are no repository, and a target that is there", async () => {
    const at = await home();
    await mkdir(join(at, "taken"));
    const { binary } = await fakeGit(at);
    const places = new Places({
      home: at,
      os: "linux",
      run: gh(),
      git: binary,
    });
    for (const url of ["--upload-pack=evil", "not a repo"])
      await expect(
        places.clone({ op: "clone", url, target: "~/x" }),
      ).rejects.toMatchObject({ failure: { code: "invalid" } });
    await expect(
      places.clone({ op: "clone", url: "a/b", target: "~/taken" }),
    ).rejects.toMatchObject({ failure: { code: "exists" } });
    await expect(
      places.clone({ op: "clone", url: "a/b", target: "~/missing/x" }),
    ).rejects.toMatchObject({ failure: { code: "not_found" } });
  });

  it("checks where a clone goes by Windows rules on a Windows machine", async () => {
    const fs = fakeFs("win32", [
      "C:\\Users\\Ada\\Developer\\Hello-World",
      "D:\\work",
    ]);
    const places = new Places({
      home: "C:\\Users\\Ada",
      os: "win32",
      fs,
      run: gh(),
    });
    await expect(
      places.clone({
        op: "clone",
        url: "octocat/Hello-World",
        protocol: "https",
        target: "~/developer/hello-world",
      }),
    ).rejects.toMatchObject({ failure: { code: "exists" } });
    await expect(
      places.clone({
        op: "clone",
        url: "octocat/Hello-World",
        protocol: "https",
        target: "E:/nothing/here",
      }),
    ).rejects.toMatchObject({ failure: { code: "not_found" } });
  });
});

describe("a clone that does not finish", () => {
  it("stops when cancelled and removes what it left", async () => {
    const at = await home();
    const { binary } = await fakeGit(at);
    process.env.FAKE_GIT_MODE = "hang";
    const places = new Places({
      home: at,
      os: "linux",
      run: gh(),
      git: binary,
    });
    const stop = new AbortController();
    const events: unknown[] = [];
    const cloning = places.clone(
      { op: "clone", url: "a/b", protocol: "https", target: "~/b" },
      { signal: stop.signal, onProgress: (event) => events.push(event) },
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    stop.abort();
    await expect(cloning).rejects.toMatchObject({
      failure: { code: "cancelled" },
    });
    expect(events).toEqual([{ phase: "receiving", percent: 5 }]);
    expect(existsSync(join(at, "b"))).toBe(false);
  });

  it("says which trouble it was", async () => {
    const cases: [string, string][] = [
      [
        "fatal: Authentication failed for 'https://github.com/a/b.git/'",
        "auth",
      ],
      [
        "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
        "auth",
      ],
      [
        "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.",
        "auth",
      ],
      [
        "remote: Repository not found.\nfatal: repository 'https://github.com/a/nope.git/' not found",
        "repo_not_found",
      ],
      [
        "fatal: unable to access 'https://github.com/a/b.git/': Could not resolve host: github.com",
        "network",
      ],
      [
        "ssh: connect to host github.com port 22: Connection timed out\nfatal: Could not read from remote repository.",
        "network",
      ],
      [
        "fatal: destination path 'b' already exists and is not an empty directory.",
        "exists",
      ],
      ["fatal: something new", "other"],
    ];
    for (const [stderr, code] of cases)
      expect(classifyCloneFailure(stderr).failure.code, stderr).toBe(code);
    const at = await home();
    const { binary } = await fakeGit(at);
    process.env.FAKE_GIT_MODE = "auth";
    const places = new Places({
      home: at,
      os: "linux",
      run: gh(),
      git: binary,
    });
    const reply = await places.serve({
      op: "clone",
      url: "a/b",
      protocol: "https",
      target: "~/b",
    });
    expect(reply).toMatchObject({ ok: false, failure: { code: "auth" } });
    expect(existsSync(join(at, "b"))).toBe(false);
  });

  it("says git is missing", async () => {
    const at = await home();
    const places = new Places({
      home: at,
      os: "linux",
      run: gh(),
      git: join(at, "no-git"),
    });
    await expect(
      places.clone({
        op: "clone",
        url: "a/b",
        protocol: "https",
        target: "~/b",
      }),
    ).rejects.toMatchObject({ failure: { code: "no_git" } });
  });
});

describe("a real git", () => {
  it("clones a repository and gives back where it is", async () => {
    const at = await home();
    const origin = join(at, "origin");
    await mkdir(origin);
    await exec("git", ["init", "-q", "-b", "main", origin]);
    await writeFile(join(origin, "README.md"), "hello");
    await exec("git", ["-C", origin, "add", "."]);
    await exec("git", [
      "-C",
      origin,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "commit",
      "-q",
      "-m",
      "one",
    ]);
    await mkdir(join(at, "Developer"));
    const places = new Places({ home: at, os: "linux" });
    const done = await places.clone({
      op: "clone",
      url: `file://${origin}`,
      target: "~/Developer/copy",
    });
    expect(done.display).toBe("~/Developer/copy");
    expect(existsSync(join(at, "Developer/copy/README.md"))).toBe(true);
    expect((await places.list("~/Developer")).entries).toMatchObject([
      { name: "copy", git: true },
    ]);
    const failed = await places.serve({
      op: "clone",
      url: `file://${join(at, "nope")}`,
      target: "~/Developer/nope",
    });
    expect(failed).toMatchObject({
      ok: false,
      failure: { code: "repo_not_found" },
    });
    expect(existsSync(join(at, "Developer/nope"))).toBe(false);
  });
});
