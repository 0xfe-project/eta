/**
 * Choosing a directory on a machine (`places.*`): answered by the machine the directory is on, by
 * that machine's rules, with what only the host knows added (projects, recent use, where the last
 * clone went). The primary answers in the host's process; a remote machine is a real daemon.
 */
import type {
  CloneView,
  PlaceCapabilities,
  PlaceFailure,
  PlaceListing,
  PlaceSearchResult,
  ProjectResults,
  RecentPlace,
} from "@eta/client-contracts";
import type { PlaceFs, PlaceRunner } from "@eta/places";
import { execFile } from "node:child_process";
import * as nodeFs from "node:fs";
import { existsSync } from "node:fs";
import { chmod, mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { PlaceError, Places } from "@eta/places";
import { describe, expect, it } from "vitest";
import { until } from "./support/client";
import { approve, startDaemon } from "./support/daemon";
import { tempDir } from "./support/host";
import { world } from "./support/world";

const exec = promisify(execFile);

interface Caller {
  client: {
    call: (t: string, a: string, args: unknown) => Promise<unknown>;
    subscribe: (target: string) => void;
    section: <T>(target: string, name: string) => T | undefined;
  };
}

const call = async <T>(w: Caller, action: string, args: unknown) =>
  (await w.client.call("places", action, args)) as T;

const problem = async (promise: Promise<unknown>) =>
  await promise.then(
    () => undefined,
    (error: { problem?: { code: string } }) => error.problem?.code,
  );

/** gh signed in or not, git there or not; nothing else is run. */
const programs =
  (gh: "ready" | "signed_out" | "missing" = "missing"): PlaceRunner =>
  async (command, args) => {
    if (command === "git" && args[0] === "--version")
      return { code: 0, stdout: "git version 2", stderr: "" };
    if (command === "gh") {
      if (gh === "missing")
        return { code: 127, stdout: "", stderr: "", missing: true };
      if (args[0] === "--version") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "auth")
        return { code: gh === "ready" ? 0 : 1, stdout: "", stderr: "" };
      return { code: 0, stdout: "[]", stderr: "" };
    }
    return { code: 127, stdout: "", stderr: "", missing: true };
  };

/** A primary whose home is a temporary directory. */
async function primaryWorld(options: { run?: PlaceRunner; git?: string } = {}) {
  const home = await realpath(await tempDir("eta-places-home-"));
  const places = new Places({
    home,
    os: "linux",
    ...(options.run === undefined ? {} : { run: options.run }),
    ...(options.git === undefined ? {} : { git: options.git }),
  });
  const w = await world({ places });
  w.client.subscribe("places");
  return { w, home };
}

const recentOf = (w: Caller, machineId: string) =>
  (w.client.section<RecentPlace[]>("places", "recent") ?? []).filter(
    (place) => place.machineId === machineId,
  );

const primaryId = (w: Awaited<ReturnType<typeof world>>) =>
  w.host.db
    .query<{ id: string }, []>("SELECT id FROM machine WHERE kind = 'primary'")
    .get()!.id;

describe("places on the primary", () => {
  it("lists a level with crumbs and display paths, marking the projects there", async () => {
    const { w, home } = await primaryWorld();
    await mkdir(join(home, "Developer/eta/.git"), { recursive: true });
    await mkdir(join(home, "Developer/notes"));
    const project = await w.project({ path: join(home, "Developer/eta") });
    const listing = await call<PlaceListing>(w, "list", {
      path: "~/Developer",
    });
    expect(listing).toMatchObject({
      display: "~/Developer",
      crumbs: [{ name: "~" }, { name: "Developer" }],
    });
    expect(listing.entries.map((e) => [e.name, e.git, e.projectId])).toEqual([
      ["eta", true, project.id],
      ["notes", false, null],
    ]);
    const found = await call<PlaceSearchResult>(w, "search", { query: "eta" });
    expect(found.matches[0]).toMatchObject({
      display: "~/Developer/eta",
      projectId: project.id,
      git: true,
    });
    expect(project.display).toBe("~/Developer/eta");
  });

  it("makes a directory, and says why it cannot", async () => {
    const { w, home } = await primaryWorld();
    expect(await call(w, "mkdir", { parent: "~", name: "fresh" })).toEqual({
      path: join(home, "fresh"),
      display: "~/fresh",
    });
    expect(existsSync(join(home, "fresh"))).toBe(true);
    expect(
      await problem(call(w, "mkdir", { parent: "~", name: "fresh" })),
    ).toBe("exists");
    expect(await problem(call(w, "mkdir", { parent: "~", name: "a/b" }))).toBe(
      "invalid",
    );
    expect(await problem(call(w, "list", { path: "~/nowhere" }))).toBe(
      "not_found",
    );
    expect(await problem(call(w, "list", { path: "relative" }))).toBe(
      "not_absolute",
    );
    expect(
      await problem(call(w, "list", { machineId: "nope" })),
    ).toBeUndefined();
  });

  it("says what the machine can do, with where a clone goes", async () => {
    const { w, home } = await primaryWorld({ run: programs("signed_out") });
    const before = await call<PlaceCapabilities>(w, "capabilities", {});
    expect(before).toMatchObject({
      flavor: "posix",
      home,
      git: true,
      gh: "signed_out",
      mkdir: true,
    });
    // No ~/Developer: the home.
    expect(before.cloneParent).toEqual({ path: home, display: "~" });
    await mkdir(join(home, "Developer"));
    expect(
      (await call<PlaceCapabilities>(w, "capabilities", {})).cloneParent,
    ).toEqual({
      path: join(home, "Developer"),
      display: "~/Developer",
    });
    // The last clone's parent, once there was one.
    await mkdir(join(home, "src"));
    w.host.db
      .query(
        "INSERT INTO place_clone_parent (machine_id, path, updated_at) VALUES (?, ?, 1)",
      )
      .run(primaryId(w), join(home, "src"));
    expect(
      (await call<PlaceCapabilities>(w, "capabilities", {})).cloneParent
        .display,
    ).toBe("~/src");
    expect(await call(w, "repos", { query: "eta" })).toEqual({
      available: false,
      reason: "gh_signed_out",
    });
  });
});

describe("projects.create, by the machine's rules", () => {
  it("expands ~ on the machine and refuses what is not a directory there", async () => {
    const { w, home } = await primaryWorld();
    await mkdir(join(home, "code"));
    await writeFile(join(home, "file"), "x");
    const made = (await w.client.call("projects", "create", {
      path: "~/code/",
    })) as ProjectResults["create"];
    expect(made.project).toMatchObject({
      path: join(home, "code"),
      display: "~/code",
      name: "code",
    });
    await expect(
      w.client.call("projects", "create", { path: "relative/x" }),
    ).rejects.toThrow(/absolute/);
    await expect(
      w.client.call("projects", "create", { path: "~/none" }),
    ).rejects.toThrow(/no such directory/);
    await expect(
      w.client.call("projects", "create", { path: "~/file" }),
    ).rejects.toThrow(/not a directory/);
    expect(
      await problem(w.client.call("projects", "create", { path: "C:\\Users" })),
    ).toBe("invalid");
    // Making it is using it.
    await until(
      () => recentOf(w, primaryId(w))[0]?.path === join(home, "code"),
    );
  });
});

describe("recent places", () => {
  it("puts what was used first, then the projects, and shares them with every client", async () => {
    const { w, home } = await primaryWorld();
    await mkdir(join(home, "a"));
    await mkdir(join(home, "b"));
    const project = await w.project({ path: join(home, "a") });
    await call(w, "remember", { path: "~/b" });
    await until(() => recentOf(w, primaryId(w)).length === 2);
    expect(
      recentOf(w, primaryId(w)).map((p) => [p.display, p.projectId]),
    ).toEqual([
      ["~/b", null],
      ["~/a", project.id],
    ]);
  });

  it("imports what a client kept before, once: behind what is known, nothing lost, nothing twice", async () => {
    const { w, home } = await primaryWorld();
    const machineId = primaryId(w);
    await call(w, "remember", { path: "~/now" });
    // The shapes the web (`workspace.recentDirectories`) and the phone (`eta.recentDirectories`)
    // kept: by machine, most recent first; both clients send theirs, overlapping.
    const web = {
      [machineId]: [join(home, "web-1"), join(home, "both")],
      gone: ["/x"],
    };
    const phone = { [machineId]: [join(home, "both"), join(home, "phone-1")] };
    expect(await call(w, "importRecent", { recent: web })).toEqual({
      added: 2,
    });
    expect(await call(w, "importRecent", { recent: phone })).toEqual({
      added: 1,
    });
    expect(await call(w, "importRecent", { recent: web })).toEqual({
      added: 0,
    });
    await until(() => recentOf(w, machineId).length === 4);
    expect(recentOf(w, machineId).map((p) => p.display)).toEqual([
      "~/now",
      "~/web-1",
      "~/both",
      "~/phone-1",
    ]);
  });
});

describe("cloning on the primary", () => {
  it("clones a repository with a real git, in the background, and remembers where", async () => {
    const { w, home } = await primaryWorld();
    const origin = join(home, "origin");
    await mkdir(origin);
    await exec("git", ["init", "-q", "-b", "main", origin]);
    await writeFile(join(origin, "README.md"), "hi");
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
    await mkdir(join(home, "src"));
    const { clone } = await call<{ clone: CloneView }>(w, "clone", {
      url: `file://${origin}`,
      parent: "~/src",
    });
    expect(clone).toMatchObject({
      status: "running",
      target: { display: "~/src/origin" },
    });
    const done = () =>
      w.client
        .section<CloneView[]>("places", "clones")
        ?.find((c) => c.id === clone.id);
    await until(() => done()?.status === "done", 15_000);
    expect(existsSync(join(home, "src/origin/README.md"))).toBe(true);
    expect(
      (await call<PlaceCapabilities>(w, "capabilities", {})).cloneParent
        .display,
    ).toBe("~/src");
    expect(recentOf(w, primaryId(w))[0]?.display).toBe("~/src/origin");
    // Into a directory that is there now: refused by the machine.
    const again = await call<{ clone: CloneView }>(w, "clone", {
      url: `file://${origin}`,
      parent: "~/src",
    });
    await until(
      () =>
        w.client
          .section<CloneView[]>("places", "clones")
          ?.find((c) => c.id === again.clone.id)?.status === "failed",
    );
    expect(
      w.client
        .section<CloneView[]>("places", "clones")
        ?.find((c) => c.id === again.clone.id)?.failure,
    ).toEqual({ code: "exists" } satisfies PlaceFailure);
  });

  it("stops a clone when cancelled", async () => {
    // A git that says how far it got, then waits to be stopped.
    const bin = await tempDir("eta-places-git-");
    const git = join(bin, "git");
    await writeFile(
      git,
      `#!/bin/sh\nprintf 'Receiving objects:  20%% (2/10)\\r' >&2\nexec sleep 60\n`,
    );
    await chmod(git, 0o755);
    const run = programs();
    const { w } = await primaryWorld({ run, git });
    const { clone } = await call<{ clone: CloneView }>(w, "clone", {
      url: "octocat/Hello-World",
      protocol: "https",
      parent: "~",
    });
    const view = () =>
      w.client
        .section<CloneView[]>("places", "clones")
        ?.find((c) => c.id === clone.id);
    await until(() => view()?.progress?.percent === 20);
    expect(await call(w, "cancelClone", { cloneId: clone.id })).toEqual({
      cancelled: true,
    });
    await until(() => view()?.status === "cancelled");
    expect(view()?.failure).toEqual({ code: "cancelled" });
    expect(await call(w, "cancelClone", { cloneId: clone.id })).toEqual({
      cancelled: false,
    });
  });
});

describe("places on a remote machine", () => {
  it("lists, searches, makes and clones on the daemon's own filesystem", async () => {
    const w = await world();
    w.client.subscribe("places");
    const daemonHome = await realpath(await tempDir("eta-daemon-home-"));
    const daemon = await startDaemon(w.host, w.client, {
      node: { places: new Places({ home: daemonHome, os: "linux" }) },
    });
    await approve(w.client, daemon);
    const machineId = daemon.machineId;
    await mkdir(join(daemonHome, "work/remote-repo/.git"), { recursive: true });

    const listing = await call<PlaceListing>(w, "list", { machineId });
    expect(listing).toMatchObject({ path: daemonHome, display: "~" });
    expect(listing.entries.map((e) => e.name)).toEqual(["work"]);
    const found = await call<PlaceSearchResult>(w, "search", {
      machineId,
      query: "remote",
    });
    expect(found.matches).toMatchObject([
      { display: "~/work/remote-repo", git: true },
    ]);
    expect(
      await call(w, "mkdir", {
        machineId,
        parent: "~/work",
        name: "made-here",
      }),
    ).toEqual({
      path: join(daemonHome, "work/made-here"),
      display: "~/work/made-here",
    });
    expect(existsSync(join(daemonHome, "work/made-here"))).toBe(true);

    const origin = join(daemonHome, "origin");
    await mkdir(origin);
    await exec("git", ["init", "-q", "-b", "main", origin]);
    await writeFile(join(origin, "f"), "x");
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
    const { clone } = await call<{ clone: CloneView }>(w, "clone", {
      machineId,
      url: `file://${origin}`,
      parent: "~/work",
      name: "copy",
    });
    await until(
      () =>
        w.client
          .section<CloneView[]>("places", "clones")
          ?.find((c) => c.id === clone.id)?.status === "done",
      15_000,
    );
    expect(existsSync(join(daemonHome, "work/copy/f"))).toBe(true);

    const made = (await w.client.call("projects", "create", {
      machineId,
      path: "~/work/copy",
    })) as ProjectResults["create"];
    expect(made.project).toMatchObject({
      machineId,
      path: join(daemonHome, "work/copy"),
      display: "~/work/copy",
    });

    await daemon.stop();
    await until(() => w.host.product.hub.link(machineId) === undefined);
    expect(await problem(call(w, "list", { machineId }))).toBe("offline");
  });

  it("takes a Windows path on a Windows daemon, whatever the host runs on", async () => {
    const w = await world();
    const fs = windowsFs(["C:\\Users\\Ada\\code\\eta", "D:\\work"]);
    const daemon = await startDaemon(w.host, w.client, {
      node: {
        places: new Places({
          home: "C:\\Users\\Ada",
          os: "win32",
          fs,
          run: programs(),
        }),
      },
    });
    await approve(w.client, daemon);
    const machineId = daemon.machineId;
    const made = (await w.client.call("projects", "create", {
      machineId,
      path: "C:\\Users\\Ada\\code\\eta",
    })) as ProjectResults["create"];
    expect(made.project).toMatchObject({
      path: "C:\\Users\\Ada\\code\\eta",
      display: "~\\code\\eta",
      name: "eta",
    });
    const tilde = (await w.client.call("projects", "create", {
      machineId,
      path: "~/code/eta",
    })) as ProjectResults["create"];
    expect(tilde).toMatchObject({
      existed: true,
      project: { id: made.project.id },
    });
    const drive = (await w.client.call("projects", "create", {
      machineId,
      path: "d:/work/",
    })) as ProjectResults["create"];
    expect(drive.project).toMatchObject({ path: "d:\\work", name: "work" });
    await expect(
      w.client.call("projects", "create", { machineId, path: "/home/ada" }),
    ).rejects.toThrow(/not a path on that machine/);
    const listing = await call<PlaceListing>(w, "list", {
      machineId,
      path: "C:/Users/Ada/code",
    });
    expect(listing).toMatchObject({
      display: "~\\code",
      drives: ["C:\\", "D:\\"],
    });
    expect(listing.entries).toMatchObject([
      { name: "eta", projectId: made.project.id },
    ]);
  });

  it("does not reach an SSH machine yet, and says so", async () => {
    const w = await world();
    const id = crypto.randomUUID();
    w.host.db
      .query(
        "INSERT INTO machine (id, kind, name, status, home, os, created_at) VALUES (?, 'ssh', 'nas', 'online', '/home/nas', 'linux', 1)",
      )
      .run(id);
    expect(await problem(call(w, "list", { machineId: id }))).toBe(
      "unsupported",
    );
    expect(
      await problem(
        w.client.call("projects", "create", { machineId: id, path: "/srv" }),
      ),
    ).toBe("unsupported");
  });
});

/** A Windows filesystem kept in memory: the paths, and every directory above them. */
function windowsFs(paths: string[]): PlaceFs {
  const dirs = new Set<string>();
  for (const path of paths) {
    let at = path;
    while (!dirs.has(at.toLowerCase())) {
      dirs.add(at.toLowerCase());
      const cut = at.lastIndexOf("\\");
      if (cut < 0 || at.endsWith(":\\")) break;
      at = cut === 2 ? at.slice(0, 3) : at.slice(0, cut);
    }
  }
  const fs: Omit<PlaceFs, "walker"> = {
    async list(path) {
      const at = path.toLowerCase().replace(/\\$/, "");
      if (!dirs.has(path.toLowerCase())) throw new PlaceError("not_found");
      return paths
        .flatMap((p) => {
          const lower = p.toLowerCase();
          if (!lower.startsWith(`${at}\\`)) return [];
          return [p.slice(at.length + 1).split("\\")[0]!];
        })
        .filter((name, index, all) => all.indexOf(name) === index)
        .map((name) => ({ name, kind: "directory" as const }));
    },
    async stat(path) {
      return dirs.has(path.toLowerCase()) ? { directory: true } : undefined;
    },
    async mkdir(path) {
      dirs.add(path.toLowerCase());
    },
    async remove() {},
  };
  // Nothing here searches the Windows home, so the walk is never asked for.
  return { ...fs, walker: nodeFs };
}
