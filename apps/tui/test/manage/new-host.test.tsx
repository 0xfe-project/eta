/**
 * `/new` on a real host: where (an existing project, a typed path, or a directory browsed to), who
 * (members and steward), and starting (the project made first when there is none, then the conversation, the
 * new tab opened). Directory listings come from a temporary tree (see `directories.ts`); the
 * projects and conversations are the host's.
 */
import type { ProjectView } from "@eta/client-contracts";
import type { RenderedApp } from "../ui-support/app";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { screenShows } from "../conversation/view-host-world";
import { tempDir, until } from "../support/temp";
import { KEYS, plain, realDelay } from "../ui-support/render";
import { listDirectories } from "./directories";
import { askedStarting, enter, manageWorld, statusLine, tabBar } from "./world";

const TITLE = "New conversation";

/** The line holding `text`, without the layer's border. */
function lineWith(r: RenderedApp, text: string): string {
  return (
    plain(r)
      .split("\n")
      .find((line) => line.includes(text))
      ?.replace(/[│┌┐└┘─]/g, "")
      .trim() ?? ""
  );
}

/** The layer's row that starts with `name`, past the cursor mark. */
function rowOf(r: Pick<RenderedApp, "lastFrame">, name: string): string {
  return (
    plain(r)
      .split("\n")
      .map((line) =>
        line
          .replace(/[│┌┐└┘─]/g, "")
          .replace(/^\s*›?\s*/, "")
          .trimEnd(),
      )
      .find((line) => line === name || line.startsWith(`${name} `)) ?? ""
  );
}

/** The layer's text, from its title down. */
function layer(r: RenderedApp): string {
  const lines = plain(r).split("\n");
  const start = lines.findIndex((line) => line.includes(TITLE));
  return start === -1 ? "" : lines.slice(start).join("\n");
}

/**
 * A home with `work/` in it: `app` (a git repository), `lib`, `.secret` (hidden) and `proj` (a
 * project on the host already).
 */
async function tree(world: Awaited<ReturnType<typeof manageWorld>>) {
  const home = await tempDir("eta-tui-home-");
  const work = join(home, "work");
  for (const dir of ["app/.git", "lib", ".secret", "proj"])
    await mkdir(join(work, dir), { recursive: true });
  const proj = (
    await world.raw.call<{ project: ProjectView }>("projects", "create", {
      path: join(work, "proj"),
    })
  ).project;
  world.answerOn(
    "projects.directories",
    listDirectories({ home, projects: new Map([[proj.path, proj.id]]) }),
  );
  return { home, work, proj };
}

/** From the first step, opens browsing: its line comes after the projects and "Type a path…". */
async function openBrowsing(r: RenderedApp, projects: number) {
  await screenShows(r, "Browse a directory…");
  for (let i = 0; i <= projects; i += 1) await r.press(KEYS.down);
  await r.press(KEYS.enter);
  await screenShows(r, "Use this directory");
}

/** The conversations the host has now beyond those listed in `before`. */
function newConversations(
  w: Awaited<ReturnType<typeof manageWorld>>,
  before: number,
) {
  return w.conversations().slice(before);
}

describe("/new with no agents", () => {
  it("says to create one first and opens no layer", async () => {
    const w = await manageWorld();
    const r = await w.showHome();
    await enter(r, "/new");
    await screenShows(r, "There are no agents yet. Create one first");
    expect(plain(r)).not.toContain(TITLE);
    expect(askedStarting(w.wire, "projects.")).toEqual([]);
  }, 60_000);
});

describe("/new, first step", () => {
  it("lists the projects a conversation can start in, newest first, then browsing", async () => {
    const w = await manageWorld();
    const ada = await w.agent("Ada");
    const older = await w.project(ada.id);
    const newer = await w.project(ada.id);
    const archived = await w.project(ada.id);
    await w.raw.call("projects", "update", {
      projectId: archived.id,
      archived: true,
    });
    const r = await w.showHome();
    await w.agentsArrived(1);
    await enter(r, "/new");
    await screenShows(r, newer.name);
    const text = layer(r);
    expect(text).toContain(older.name);
    expect(text).toContain(newer.path);
    expect(text.indexOf(newer.name)).toBeLessThan(text.indexOf(older.name));
    expect(text.indexOf(older.name)).toBeLessThan(text.indexOf("Type a path…"));
    expect(text.indexOf("Type a path…")).toBeLessThan(
      text.indexOf("Browse a directory…"),
    );
    expect(text).not.toContain(archived.name);
    // Ada's workspace is a project of the agent_home kind: not offered.
    expect(text).not.toContain(ada.home);
  }, 60_000);

  it("starts in the project chosen with the only agent, without asking who", async () => {
    const w = await manageWorld();
    const ada = await w.agent("Ada");
    await w.project(ada.id);
    const newer = await w.project(ada.id);
    const r = await w.showHome();
    await w.agentsArrived(1);
    const before = w.conversations().length;
    await enter(r, "/new");
    await screenShows(r, newer.name);
    await r.press(KEYS.enter);
    await until(
      () => newConversations(w, before).length === 1,
      10_000,
      "the new conversation",
    );
    const made = newConversations(w, before)[0]!;
    expect(made.projectId).toBe(newer.id);
    expect(made.participants.map((p) => p.agentId)).toEqual([ada.id]);
    // A tab's name is cut at 20 columns.
    await screenShows(r, `1:${made.name.slice(0, 10)}`);
    expect(plain(r)).not.toContain(TITLE);
    expect(statusLine(r)).toContain(`Started ${made.name}`);
    expect(askedStarting(w.wire, "projects.create")).toEqual([]);
    expect(askedStarting(w.wire, "conversations.create")).toEqual([
      {
        op: "conversations.create",
        args: { projectId: newer.id, agentIds: [ada.id], stewardId: ada.id },
      },
    ]);
  }, 60_000);

  it("closes on Esc and leaves nothing on the host", async () => {
    const w = await manageWorld();
    const ada = await w.agent("Ada");
    await w.agent("Ben");
    await w.project(ada.id);
    const r = await w.showHome();
    await w.agentsArrived(2);
    const before = w.conversations().length;
    await enter(r, "/new");
    await screenShows(r, "Browse a directory…");
    await r.press(KEYS.enter); // into the second step
    await screenShows(r, "steward");
    await r.press(KEYS.escape); // back to the first
    await screenShows(r, "Browse a directory…");
    await r.press(KEYS.escape);
    await realDelay(100);
    expect(plain(r)).not.toContain(TITLE);
    expect(w.conversations()).toHaveLength(before);
    expect(askedStarting(w.wire, "projects.create")).toEqual([]);
    expect(askedStarting(w.wire, "conversations.create")).toEqual([]);
  }, 60_000);
});

describe("/new, browsing", () => {
  it("lists the visible subdirectories with their marks, goes in and back up", async () => {
    const w = await manageWorld();
    await w.agent("Ada");
    const r = await w.showHome();
    await w.agentsArrived(1);
    const { work, home } = await tree(w);
    await enter(r, "/new");
    await openBrowsing(r, 1); // proj is the one project
    await r.press(KEYS.down); // work, the only directory at home
    await r.press(KEYS.enter);
    await screenShows(
      r,
      (screen) => rowOf({ lastFrame: () => screen }, "lib") === "lib",
    );
    const text = layer(r);
    expect(text).toContain(work);
    expect(rowOf(r, "app")).toMatch(/^app\s+git$/);
    expect(rowOf(r, "lib")).toBe("lib");
    expect(rowOf(r, "proj")).toMatch(/^proj\s+project$/);
    expect(text).not.toContain(".secret");
    expect(text.indexOf("Use this directory")).toBeLessThan(
      text.indexOf("app"),
    );

    await r.press(KEYS.down);
    await r.press(KEYS.down); // lib
    await r.press(KEYS.enter);
    await screenShows(r, join(work, "lib"));
    await r.press(KEYS.left);
    await screenShows(
      r,
      (screen) => screen.includes(work) && !screen.includes(join(work, "lib")),
    );
    await r.press(KEYS.backspace);
    await screenShows(
      r,
      (screen) => rowOf({ lastFrame: () => screen }, "work") === "work",
    );
    expect(
      askedStarting(w.wire, "projects.directories").map((a) => a.args),
    ).toEqual([
      {},
      { path: work },
      { path: join(work, "lib") },
      { path: work },
      { path: home },
    ]);
  }, 60_000);

  it("says why a listing failed and that a path can be typed instead", async () => {
    const w = await manageWorld();
    await w.agent("Ada");
    const r = await w.showHome();
    await w.agentsArrived(1);
    const home = join(await tempDir("eta-tui-gone-"), "nowhere");
    w.answerOn("projects.directories", listDirectories({ home }));
    await enter(r, "/new");
    await screenShows(r, "Browse a directory…");
    await r.press(KEYS.down);
    await r.press(KEYS.enter);
    await screenShows(r, "You can type a path instead");
    expect(lineWith(r, "You can type a path instead")).toContain(
      "No such directory: ~",
    );
  }, 60_000);

  it("does not go above a root", async () => {
    const w = await manageWorld();
    await w.agent("Ada");
    const r = await w.showHome();
    await w.agentsArrived(1);
    const root = join(await tempDir("eta-tui-root-"), "x");
    await mkdir(root);
    w.answerOn("projects.directories", async () => ({
      path: root,
      home: root,
      parent: null,
      entries: [],
      truncated: false,
    }));
    await enter(r, "/new");
    await openBrowsing(r, 0);
    const asked = askedStarting(w.wire, "projects.directories").length;
    await r.press(KEYS.left);
    await realDelay(100);
    expect(askedStarting(w.wire, "projects.directories")).toHaveLength(asked);
  }, 60_000);

  it("says when the listing was cut short", async () => {
    const w = await manageWorld();
    await w.agent("Ada");
    const r = await w.showHome();
    await w.agentsArrived(1);
    const home = await tempDir("eta-tui-home-");
    for (const dir of ["a", "b", "c"]) await mkdir(join(home, dir));
    w.answerOn("projects.directories", listDirectories({ home, limit: 2 }));
    await enter(r, "/new");
    await openBrowsing(r, 0);
    await screenShows(r, "More directories are not listed");
    expect(layer(r)).not.toMatch(/\bc\b/);
  }, 60_000);

  it("makes the project for a directory browsed to, then the conversation, and opens it", async () => {
    const w = await manageWorld();
    const ada = await w.agent("Ada");
    const r = await w.showHome();
    await w.agentsArrived(1);
    const { work } = await tree(w);
    const before = w.conversations().length;
    await enter(r, "/new");
    await openBrowsing(r, 1);
    await r.press(KEYS.down); // work
    await r.press(KEYS.enter);
    await screenShows(
      r,
      (screen) => rowOf({ lastFrame: () => screen }, "lib") === "lib",
    );
    await r.press(KEYS.down);
    await r.press(KEYS.down); // lib
    await r.press(KEYS.enter);
    await screenShows(r, join(work, "lib"));
    await r.press(KEYS.enter); // use it
    await until(
      () => newConversations(w, before).length === 1,
      10_000,
      "the new conversation",
    );
    const made = newConversations(w, before)[0]!;
    const project = w.projects().find((p) => p.id === made.projectId);
    await until(
      () => w.projects().some((p) => p.id === made.projectId),
      10_000,
      "the project",
    );
    const madeProject =
      project ?? w.projects().find((p) => p.id === made.projectId)!;
    expect(madeProject.path).toBe(join(work, "lib"));
    const primary = w.machines().find((m) => m.kind === "primary")!;
    expect(
      w.wire.asked
        .filter((a) => a.op.endsWith(".create"))
        .map((a) => ({ op: a.op, args: a.args })),
    ).toEqual([
      {
        op: "projects.create",
        args: {
          path: join(work, "lib"),
          machineId: primary.id,
          stewardId: ada.id,
        },
      },
      {
        op: "conversations.create",
        args: {
          projectId: madeProject.id,
          agentIds: [ada.id],
          stewardId: ada.id,
        },
      },
    ]);
    await screenShows(r, `1:${made.name.slice(0, 10)}`);
  }, 60_000);

  it("takes a directory that is a project already as that project", async () => {
    const w = await manageWorld();
    const ada = await w.agent("Ada");
    const r = await w.showHome();
    await w.agentsArrived(1);
    const { work, proj } = await tree(w);
    const before = w.conversations().length;
    await enter(r, "/new");
    await openBrowsing(r, 1);
    await r.press(KEYS.down); // work
    await r.press(KEYS.enter);
    await screenShows(
      r,
      (screen) => rowOf({ lastFrame: () => screen }, "lib") === "lib",
    );
    for (let i = 0; i < 3; i += 1) await r.press(KEYS.down); // proj
    await r.press(KEYS.enter);
    await screenShows(r, join(work, "proj"));
    await r.press(KEYS.enter);
    await until(
      () => newConversations(w, before).length === 1,
      10_000,
      "the new conversation",
    );
    expect(newConversations(w, before)[0]!.projectId).toBe(proj.id);
    expect(askedStarting(w.wire, "projects.create")).toEqual([]);
    expect(askedStarting(w.wire, "conversations.create")).toEqual([
      {
        op: "conversations.create",
        args: { projectId: proj.id, agentIds: [ada.id], stewardId: ada.id },
      },
    ]);
  }, 60_000);

  it("/new with the path of a project takes that project, without browsing", async () => {
    const w = await manageWorld();
    const ada = await w.agent("Ada");
    const r = await w.showHome();
    await w.agentsArrived(1);
    const { work, proj } = await tree(w);
    // Taken as typed: no listing said it is a project, the project list does.
    await enter(r, `/new ${join(work, "proj")}`);
    await until(
      () => askedStarting(w.wire, "conversations.create").length === 1,
      10_000,
      "the create",
    );
    expect(askedStarting(w.wire, "projects.create")).toEqual([]);
    expect(askedStarting(w.wire, "projects.directories")).toEqual([]);
    expect(askedStarting(w.wire, "conversations.create")[0]?.args).toEqual({
      projectId: proj.id,
      agentIds: [ada.id],
      stewardId: ada.id,
    });
  }, 60_000);
});

describe("/new, typing a path", () => {
  it("makes the project at a typed directory, then the conversation", async () => {
    const w = await manageWorld();
    const ada = await w.agent("Ada");
    const r = await w.showHome();
    await w.agentsArrived(1);
    const dir = await tempDir("eta-tui-typed-");
    const before = w.conversations().length;
    await enter(r, "/new");
    await screenShows(r, "Type a path…");
    await r.press(KEYS.enter); // no projects: the first line
    await screenShows(r, "Enter use this path");
    await r.type(`  ${dir} `);
    await r.press(KEYS.enter);
    await until(
      () => newConversations(w, before).length === 1,
      10_000,
      "the new conversation",
    );
    const made = newConversations(w, before)[0]!;
    await until(
      () => w.projects().some((p) => p.id === made.projectId),
      10_000,
      "the project",
    );
    expect(w.projects().find((p) => p.id === made.projectId)?.path).toBe(dir);
    const primary = w.machines().find((m) => m.kind === "primary")!;
    expect(askedStarting(w.wire, "projects.create")).toEqual([
      {
        op: "projects.create",
        args: { path: dir, machineId: primary.id, stewardId: ada.id },
      },
    ]);
    expect(askedStarting(w.wire, "projects.directories")).toEqual([]);
    await screenShows(r, (screen) => !screen.includes(TITLE));
  }, 60_000);

  it("shows the host's refusal of a directory that does not exist in the layer, and starts nothing", async () => {
    const w = await manageWorld();
    await w.agent("Ada");
    const r = await w.showHome();
    await w.agentsArrived(1);
    const missing = join(await tempDir("eta-tui-typed-"), "nowhere");
    const before = w.conversations().length;
    await enter(r, `/new ${missing}`);
    await until(
      () => askedStarting(w.wire, "projects.create").length === 1,
      10_000,
      "the project create",
    );
    await screenShows(r, `no such directory: ${missing}`);
    expect(lineWith(r, "no such directory")).toBe(
      `no such directory: ${missing}`,
    );
    expect(plain(r)).toContain(TITLE);
    expect(askedStarting(w.wire, "conversations.create")).toEqual([]);
    expect(w.conversations()).toHaveLength(before);
    expect(w.projects().some((p) => p.path === missing)).toBe(false);
  }, 60_000);

  it("does nothing for a blank path, and goes back to the projects on Esc", async () => {
    const w = await manageWorld();
    await w.agent("Ada");
    const r = await w.showHome();
    await w.agentsArrived(1);
    await enter(r, "/new");
    await screenShows(r, "Type a path…");
    await r.press(KEYS.enter);
    await screenShows(r, "Enter use this path");
    await r.type("   ");
    await r.press(KEYS.enter);
    await realDelay(100);
    expect(plain(r)).toContain("Enter use this path");
    expect(askedStarting(w.wire, "projects.create")).toEqual([]);
    await r.press(KEYS.escape);
    await screenShows(r, "Browse a directory…");
    expect(plain(r)).not.toContain("Enter use this path");
    expect(plain(r)).toContain(TITLE);
  }, 60_000);

  it("/new with a path asks who next when there are several agents", async () => {
    const w = await manageWorld();
    const ada = await w.agent("Ada");
    const ben = await w.agent("Ben");
    const r = await w.showHome();
    await w.agentsArrived(2);
    const dir = await tempDir("eta-tui-typed-");
    await enter(r, `/new ${dir}`);
    await screenShows(r, "Space add or drop");
    expect(lineWith(r, "Ada")).toMatch(/\[x\]\s+Ada\s+steward/);
    await r.press(KEYS.down);
    await r.press(" "); // Ben too
    await r.press(KEYS.enter);
    await until(
      () => askedStarting(w.wire, "conversations.create").length === 1,
      10_000,
      "the create",
    );
    expect(askedStarting(w.wire, "projects.create")[0]?.args).toMatchObject({
      path: dir,
      stewardId: ada.id,
    });
    expect(
      askedStarting(w.wire, "conversations.create")[0]?.args,
    ).toMatchObject({ agentIds: [ada.id, ben.id], stewardId: ada.id });
  }, 60_000);
});

describe("/new, second step", () => {
  async function three() {
    const w = await manageWorld();
    const ada = await w.agent("Ada");
    const ben = await w.agent("Ben");
    const cleo = await w.agent("Cleo");
    const project = await w.project(ben.id);
    const r = await w.showHome();
    await w.agentsArrived(3);
    await enter(r, "/new");
    await screenShows(r, project.name);
    await r.press(KEYS.enter);
    await screenShows(r, "Space add or drop");
    return { w, r, ada, ben, cleo, project };
  }

  it("starts with the project's steward checked as steward", async () => {
    const { r } = await three();
    expect(lineWith(r, "Ben")).toMatch(/\[x\]\s+Ben\s+steward/);
    expect(lineWith(r, "Ada")).toMatch(/\[ \]\s+Ada$/);
    expect(lineWith(r, "Cleo")).toMatch(/\[ \]\s+Cleo$/);
  }, 60_000);

  it("starts with the first agent when the project has no steward", async () => {
    const w = await manageWorld();
    await w.agent("Ada");
    await w.agent("Ben");
    const project = await w.project();
    const r = await w.showHome();
    await w.agentsArrived(2);
    await enter(r, "/new");
    await screenShows(r, project.name);
    await r.press(KEYS.enter);
    await screenShows(r, "Space add or drop");
    expect(lineWith(r, "Ada")).toMatch(/\[x\]\s+Ada\s+steward/);
    expect(lineWith(r, "Ben")).toMatch(/\[ \]\s+Ben$/);
  }, 60_000);

  it("checks with Space, makes a checked one steward with s, ignores s on an unchecked one", async () => {
    const { r } = await three();
    await r.press(" "); // Ada checked
    expect(lineWith(r, "Ada")).toMatch(/\[x\]\s+Ada$/);
    await r.press(KEYS.down);
    await r.press(KEYS.down); // Cleo, unchecked
    await r.press("s");
    expect(lineWith(r, "Cleo")).toMatch(/\[ \]\s+Cleo$/);
    expect(lineWith(r, "Ben")).toMatch(/steward/);
    await r.press(KEYS.up);
    await r.press(KEYS.up); // Ada
    await r.press("s");
    expect(lineWith(r, "Ada")).toMatch(/\[x\]\s+Ada\s+steward/);
    expect(lineWith(r, "Ben")).toMatch(/\[x\]\s+Ben$/);
  }, 60_000);

  it("hands the steward to the first checked one left when the steward is dropped", async () => {
    const { w, r, ada, ben, cleo, project } = await three();
    await r.press(KEYS.down);
    await r.press(KEYS.down);
    await r.press(" "); // Cleo checked
    await r.press(KEYS.up);
    await r.press(" "); // Ben, the steward, dropped
    expect(lineWith(r, "Ben")).toMatch(/\[ \]\s+Ben$/);
    expect(lineWith(r, "Cleo")).toMatch(/\[x\]\s+Cleo\s+steward/);
    const before = w.conversations().length;
    await r.press(KEYS.enter);
    await until(
      () => newConversations(w, before).length === 1,
      10_000,
      "the new conversation",
    );
    const made = newConversations(w, before)[0]!;
    expect(made.participants.map((p) => p.agentId)).toEqual([cleo.id]);
    expect(made.stewardId).toBe(cleo.id);
    expect(askedStarting(w.wire, "conversations.create")[0]?.args).toEqual({
      projectId: project.id,
      agentIds: [cleo.id],
      stewardId: cleo.id,
    });
    expect(ada.id).not.toBe(ben.id);
  }, 60_000);

  it("refuses to start with nobody checked", async () => {
    const { w, r } = await three();
    await r.press(KEYS.down);
    await r.press(" "); // Ben dropped: nobody left
    expect(lineWith(r, "Ben")).toMatch(/\[ \]\s+Ben$/);
    for (const name of ["Ada", "Ben", "Cleo"])
      expect(lineWith(r, name)).not.toMatch(/steward$/);
    await r.press(KEYS.enter);
    await screenShows(r, "Choose at least one member");
    expect(plain(r)).toContain(TITLE);
    expect(askedStarting(w.wire, "conversations.create")).toEqual([]);
  }, 60_000);

  it("starts with every checked agent and the steward", async () => {
    const { w, r, ada, ben, project } = await three();
    await r.press(" "); // Ada checked
    const before = w.conversations().length;
    await r.press(KEYS.enter);
    await until(
      () => newConversations(w, before).length === 1,
      10_000,
      "the new conversation",
    );
    const made = newConversations(w, before)[0]!;
    expect(new Set(made.participants.map((p) => p.agentId))).toEqual(
      new Set([ada.id, ben.id]),
    );
    expect(askedStarting(w.wire, "conversations.create")[0]?.args).toEqual({
      projectId: project.id,
      agentIds: [ada.id, ben.id],
      stewardId: ben.id,
    });
    await screenShows(r, `1:${made.name.slice(0, 10)}`);
  }, 60_000);
});

describe("/new, starting", () => {
  it("sends once while the start is on its way", async () => {
    const w = await manageWorld();
    const ada = await w.agent("Ada");
    const project = await w.project(ada.id);
    const r = await w.showHome();
    await w.agentsArrived(1);
    const held = w.holdOn("conversations.create");
    await enter(r, "/new");
    await screenShows(r, project.name);
    await r.press(KEYS.enter);
    await held.asked;
    await screenShows(r, "Starting…");
    await r.press(KEYS.enter);
    await r.press(KEYS.enter);
    await realDelay(50);
    expect(askedStarting(w.wire, "conversations.create")).toHaveLength(1);
    held.release();
    await screenShows(r, (screen) => !screen.includes(TITLE));
    expect(askedStarting(w.wire, "conversations.create")).toHaveLength(1);
  }, 60_000);

  it("keeps the layer with the error when starting fails, and makes the project only once on a retry", async () => {
    const w = await manageWorld();
    const ada = await w.agent("Ada");
    const r = await w.showHome();
    await w.agentsArrived(1);
    const { work } = await tree(w);
    w.failOn("conversations.create", "the host is busy");
    const before = w.conversations().length;
    await enter(r, `/new ${join(work, "lib")}`);
    await screenShows(r, "the host is busy");
    expect(plain(r)).toContain(TITLE);
    expect(tabBar(r)).not.toContain("1:");
    // The path stays typed in: Enter tries again.
    await r.press(KEYS.enter);
    await until(
      () => newConversations(w, before).length === 1,
      10_000,
      "the new conversation",
    );
    expect(askedStarting(w.wire, "projects.create")).toHaveLength(1);
    expect(askedStarting(w.wire, "conversations.create")).toHaveLength(2);
    expect(
      w.projects().filter((p) => p.path === join(work, "lib")),
    ).toHaveLength(1);
    await screenShows(r, (screen) => !screen.includes(TITLE));
    expect(ada.id).toBeTruthy();
  }, 60_000);
});

describe("/new, projects that cannot take a new conversation", () => {
  it("makes a typed path of an archived project again, which brings it back, and starts there", async () => {
    const w = await manageWorld();
    const ada = await w.agent("Ada");
    const project = await w.project(ada.id);
    await w.raw.call("projects", "update", {
      projectId: project.id,
      archived: true,
    });
    const r = await w.showHome();
    await w.agentsArrived(1);
    await enter(r, `/new ${project.path}`);
    await until(
      () => askedStarting(w.wire, "conversations.create").length === 1,
      10_000,
      "the create",
    );
    expect(askedStarting(w.wire, "projects.create")).toHaveLength(1);
    expect(askedStarting(w.wire, "projects.create")[0]?.args).toMatchObject({
      path: project.path,
    });
    expect(
      askedStarting(w.wire, "conversations.create")[0]?.args,
    ).toMatchObject({ projectId: project.id });
    await until(
      () => w.projects().find((p) => p.id === project.id)?.archived === false,
      10_000,
      "the project back",
    );
  }, 60_000);

  it("makes a browsed directory whose entry names an archived project again", async () => {
    const w = await manageWorld();
    await w.agent("Ada");
    const r = await w.showHome();
    await w.agentsArrived(1);
    const { work, proj } = await tree(w);
    await w.raw.call("projects", "update", {
      projectId: proj.id,
      archived: true,
    });
    await enter(r, "/new");
    await openBrowsing(r, 0); // proj is archived: no project line
    await r.press(KEYS.down); // work
    await r.press(KEYS.enter);
    await screenShows(
      r,
      (screen) => rowOf({ lastFrame: () => screen }, "lib") === "lib",
    );
    for (let i = 0; i < 3; i += 1) await r.press(KEYS.down); // proj
    await r.press(KEYS.enter);
    await screenShows(r, join(work, "proj"));
    await r.press(KEYS.enter); // use it
    await until(
      () => askedStarting(w.wire, "conversations.create").length === 1,
      10_000,
      "the create",
    );
    expect(askedStarting(w.wire, "projects.create")[0]?.args).toMatchObject({
      path: join(work, "proj"),
    });
    expect(
      askedStarting(w.wire, "conversations.create")[0]?.args,
    ).toMatchObject({ projectId: proj.id });
  }, 60_000);
});

describe("/new, the cursor of the first step", () => {
  it("stays on the line it was on when a project comes in above it", async () => {
    const w = await manageWorld();
    const ada = await w.agent("Ada");
    const older = await w.project(ada.id);
    const r = await w.showHome();
    await w.agentsArrived(1);
    await enter(r, "/new");
    await screenShows(r, older.name);
    await r.press(KEYS.down); // Type a path…
    const newer = await w.project(ada.id);
    await screenShows(r, newer.name);
    await r.press(KEYS.enter);
    await screenShows(r, "Enter use this path");
    expect(askedStarting(w.wire, "conversations.create")).toEqual([]);
  }, 60_000);
});

describe("/new, an agent's own workspace", () => {
  const REFUSAL =
    "This directory is an agent's own workspace; start the conversation somewhere else";

  it("is refused before anything is made", async () => {
    const w = await manageWorld();
    const ada = await w.agent("Ada");
    const r = await w.showHome();
    await w.agentsArrived(1);
    await enter(r, `/new ${ada.home}`);
    await screenShows(r, REFUSAL);
    expect(askedStarting(w.wire, "projects.create")).toEqual([]);
    expect(askedStarting(w.wire, "conversations.create")).toEqual([]);
  }, 60_000);

  it("is refused when archived too, and stays archived", async () => {
    const w = await manageWorld();
    const ada = await w.agent("Ada");
    await w.raw.call("projects", "update", {
      projectId: ada.homeProjectId,
      archived: true,
    });
    const r = await w.showHome();
    await w.agentsArrived(1);
    await until(
      () =>
        w.projects().find((p) => p.id === ada.homeProjectId)?.archived === true,
      10_000,
      "the workspace archived",
    );
    await enter(r, `/new ${ada.home}`);
    await screenShows(r, REFUSAL);
    expect(askedStarting(w.wire, "projects.create")).toEqual([]);
    await realDelay(100);
    expect(w.projects().find((p) => p.id === ada.homeProjectId)?.archived).toBe(
      true,
    );
  }, 60_000);

  it("is refused when typed with several agents, without asking who", async () => {
    const w = await manageWorld();
    const ada = await w.agent("Ada");
    await w.agent("Ben");
    const r = await w.showHome();
    await w.agentsArrived(2);
    await enter(r, "/new");
    await screenShows(r, "Type a path…");
    await r.press(KEYS.enter);
    await screenShows(r, "Enter use this path");
    await r.type(ada.home);
    await r.press(KEYS.enter);
    await screenShows(r, REFUSAL);
    expect(plain(r)).not.toContain("Space add or drop");
    expect(askedStarting(w.wire, "projects.create")).toEqual([]);
  }, 60_000);
});
