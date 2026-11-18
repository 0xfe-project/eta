/**
 * `/new` on a real host: where (a directory on a machine, found by the shared places flow:
 * searched, browsed, cloned or made), who (members and steward), and starting (the project made
 * first when there is none, then the conversation, the new tab opened). The primary's places are
 * answered by the real host from a temporary home; the projects and conversations are the host's.
 */
import type { ProjectView } from "@eta/client-contracts";
import type { RenderedApp } from "../ui-support/app";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { Places } from "@eta/places";
import { describe, expect, it } from "vitest";
import { screenShows } from "../conversation/view-host-world";
import { tempDir, until } from "../support/temp";
import { KEYS, plain, realDelay } from "../ui-support/render";
import { askedStarting, enter, manageWorld, statusLine, tabBar } from "./world";

const TITLE = "New conversation";
const exec = promisify(execFile);

/** Whether the layer's title line shows; the home screen's `/new` hint carries the same words. */
function showsLayer(screen: string): boolean {
  return screen
    .split("\n")
    .some((line) => line.includes(TITLE) && !line.includes("/new"));
}

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

/** The layer's text, from its title down. */
function layer(r: RenderedApp): string {
  const lines = plain(r).split("\n");
  const start = lines.findIndex((line) => showsLayer(line));
  return start === -1 ? "" : lines.slice(start).join("\n");
}

/** The row the cursor is on. */
function cursorRow(r: RenderedApp): string {
  return (
    plain(r)
      .split("\n")
      .map((line) => line.replace(/[│┌┐└┘─]/g, "").trim())
      // The box's line comes first and starts the same way: the list's is the last.
      .filter((line) => line.startsWith("› "))
      .at(-1)
      ?.slice(2)
      .trim() ?? ""
  );
}

/**
 * A host whose primary answers places from a temporary home with `work/` in it: `app` (a git
 * repository), `lib`, `.secret` (hidden) and `proj` (a project on the host already).
 */
async function placesWorld() {
  const home = await realpath(await tempDir("eta-tui-home-"));
  const work = join(home, "work");
  for (const dir of ["app/.git", "lib", ".secret", "proj"])
    await mkdir(join(work, dir), { recursive: true });
  const w = await manageWorld(undefined, {
    places: new Places({ home, os: "linux" }),
  });
  const proj = (
    await w.raw.call<{ project: ProjectView }>("projects", "create", {
      path: join(work, "proj"),
    })
  ).project;
  return { w, home, work, proj };
}

/** From the ways, into a way: Search, Browse, GitHub and New are the first to fourth lines. */
async function way(r: RenderedApp, name: string) {
  await screenShows(r, "How do you want to add it?");
  // Until the machine has said what it can do, the ways that need it are closed.
  await screenShows(
    r,
    (screen) =>
      screen.includes("New directory") &&
      !screen.includes("checking this machine"),
  );
  const order = [
    "Search directories",
    "Browse…",
    "Clone from GitHub",
    "New directory",
  ];
  for (let i = 0; i < order.indexOf(name); i += 1) await r.press(KEYS.down);
  await r.press(KEYS.enter);
}

/** Types into the page's box and waits for a row that shows `expected`, then puts the cursor on it. */
async function search(r: RenderedApp, text: string, expected: string) {
  await r.type(text);
  await screenShows(r, (screen) =>
    screen
      .split("\n")
      .slice(4)
      .some((line) => line.replace(/[│›]/g, "").trim().startsWith(expected)),
  );
  for (let i = 0; i < 10 && !cursorRow(r).startsWith(expected); i += 1)
    await r.press(KEYS.down);
  expect(cursorRow(r).startsWith(expected), plain(r)).toBe(true);
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
    expect(showsLayer(plain(r))).toBe(false);
    expect(askedStarting(w.wire, "projects.")).toEqual([]);
  }, 60_000);
});

describe("/new, the ways", () => {
  it("starts on the four ways when there is one machine, each saying what it can do", async () => {
    const { w } = await placesWorld();
    await w.agent("Ada");
    const r = await w.showHome();
    await w.agentsArrived(1);
    await enter(r, "/new");
    await screenShows(r, "Clone from GitHub");
    const text = layer(r);
    expect(text).toContain("How do you want to add it?");
    expect(text.indexOf("Search directories")).toBeLessThan(
      text.indexOf("Browse…"),
    );
    expect(text.indexOf("Browse…")).toBeLessThan(
      text.indexOf("Clone from GitHub"),
    );
    expect(text.indexOf("Clone from GitHub")).toBeLessThan(
      text.indexOf("New directory"),
    );
    expect(cursorRow(r)).toBe("Search directories");
  }, 60_000);

  it("chooses a machine first when there are several, greys an SSH one out with the reason", async () => {
    const { w, proj } = await placesWorld();
    await w.agent("Ada");
    w.host.db
      .query(
        "INSERT INTO machine (id, kind, name, status, home, os, created_at) VALUES ('m-nas', 'ssh', 'nas', 'online', '/home/nas', 'linux', 1)",
      )
      .run();
    // A machine put in by hand is told about with the next change the host makes.
    await w.raw.call("projects", "update", {
      projectId: proj.id,
      name: "proj",
    });
    await until(() => w.machines().length === 2, 10_000, "the SSH machine");
    const r = await w.showHome();
    await w.agentsArrived(1);
    await enter(r, "/new");
    await screenShows(r, "Choose a machine");
    await screenShows(r, "nas");
    expect(lineWith(r, "nas")).toContain("SSH machines are not supported yet");
    // The cursor steps over it.
    await r.press(KEYS.down);
    expect(cursorRow(r)).not.toContain("nas");
    await r.press(KEYS.enter);
    await screenShows(r, "How do you want to add it?");
    await r.press(KEYS.escape);
    await screenShows(r, "Choose a machine");
    await r.press(KEYS.escape);
    await realDelay(100);
    expect(showsLayer(plain(r))).toBe(false);
  }, 60_000);

  it("closes on Esc a page at a time and leaves nothing on the host", async () => {
    const { w } = await placesWorld();
    await w.agent("Ada");
    await w.agent("Ben");
    const r = await w.showHome();
    await w.agentsArrived(2);
    const before = w.conversations().length;
    await enter(r, "/new");
    await way(r, "Search directories");
    await search(r, "proj", "~/work/proj");
    await r.press(KEYS.enter); // into the second step
    await screenShows(r, "steward");
    await r.press(KEYS.escape); // back to the first, as it was
    await screenShows(r, "Search by name, or type a path");
    expect(lineWith(r, "› proj")).toContain("proj");
    await r.press(KEYS.escape);
    await screenShows(r, "How do you want to add it?");
    await r.press(KEYS.escape);
    await realDelay(100);
    expect(showsLayer(plain(r))).toBe(false);
    expect(w.conversations()).toHaveLength(before);
    expect(askedStarting(w.wire, "projects.create")).toEqual([]);
    expect(askedStarting(w.wire, "conversations.create")).toEqual([]);
  }, 60_000);
});

describe("/new, searching", () => {
  it("lists the projects first, and starts in the one chosen with the only agent", async () => {
    const { w, proj } = await placesWorld();
    const ada = await w.agent("Ada");
    const r = await w.showHome();
    await w.agentsArrived(1);
    const before = w.conversations().length;
    await enter(r, "/new");
    await way(r, "Search directories");
    await screenShows(r, "~/work/proj");
    expect(lineWith(r, "~/work/proj")).toContain("project");
    await r.press(KEYS.enter);
    await until(
      () => newConversations(w, before).length === 1,
      10_000,
      "the new conversation",
    );
    const made = newConversations(w, before)[0]!;
    expect(made.projectId).toBe(proj.id);
    await screenShows(r, `1:${made.name.slice(0, 10)}`);
    expect(showsLayer(plain(r))).toBe(false);
    expect(statusLine(r)).toContain(`Started ${made.name}`);
    expect(askedStarting(w.wire, "projects.create")).toEqual([]);
    expect(askedStarting(w.wire, "conversations.create")).toEqual([
      {
        op: "conversations.create",
        args: { projectId: proj.id, agentIds: [ada.id], stewardId: ada.id },
      },
    ]);
  }, 60_000);

  it("finds directories under the machine's home by name and makes the project there", async () => {
    const { w, work } = await placesWorld();
    await w.agent("Ada");
    const r = await w.showHome();
    await w.agentsArrived(1);
    await enter(r, "/new");
    await way(r, "Search directories");
    await search(r, "lib", "~/work/lib");
    await r.press(KEYS.enter);
    await until(
      () => askedStarting(w.wire, "conversations.create").length === 1,
      10_000,
      "the create",
    );
    const primary = w.machines().find((m) => m.kind === "primary")!;
    expect(askedStarting(w.wire, "projects.create")).toEqual([
      {
        op: "projects.create",
        args: { path: join(work, "lib"), machineId: primary.id },
      },
    ]);
  }, 60_000);

  it("offers a typed path first, checks it on the machine, and says when it is not there", async () => {
    const { w, home } = await placesWorld();
    await w.agent("Ada");
    const r = await w.showHome();
    await w.agentsArrived(1);
    await enter(r, "/new");
    await way(r, "Search directories");
    await search(r, "~/nowhere", "Open ~/nowhere");
    expect(cursorRow(r)).toBe("Open ~/nowhere");
    expect(lineWith(r, "Open ~/nowhere")).not.toBe("");
    await r.press(KEYS.enter);
    await screenShows(r, "That directory does not exist");
    expect(askedStarting(w.wire, "places.resolve")).toEqual([
      expect.objectContaining({
        args: expect.objectContaining({ path: "~/nowhere" }),
      }),
    ]);
    expect(askedStarting(w.wire, "projects.create")).toEqual([]);
    expect(showsLayer(plain(r))).toBe(true);
    expect(existsSync(join(home, "nowhere"))).toBe(false);
  }, 60_000);
});

describe("/new, browsing", () => {
  it("lists the visible subdirectories with their marks, Tab shows the hidden ones, ← goes up", async () => {
    const { w } = await placesWorld();
    await w.agent("Ada");
    const r = await w.showHome();
    await w.agentsArrived(1);
    await enter(r, "/new");
    await way(r, "Browse…");
    await screenShows(r, "Use this directory");
    await screenShows(r, "work");
    await r.press(KEYS.down);
    await r.press(KEYS.enter);
    await screenShows(r, "~/work");
    await screenShows(r, "lib");
    expect(lineWith(r, "app")).toContain("git");
    expect(lineWith(r, "proj")).toContain("project");
    expect(layer(r)).not.toContain(".secret");
    await r.press(KEYS.tab);
    await screenShows(r, ".secret");
    await r.press(KEYS.left);
    await screenShows(r, (screen) => !screen.includes(" lib"));
  }, 60_000);

  it.skipIf(process.getuid?.() === 0)(
    "says why a directory cannot be read, and ← goes back to the one that could",
    async () => {
      const { w, work } = await placesWorld();
      await mkdir(join(work, "locked"));
      await chmod(join(work, "locked"), 0o000);
      try {
        await w.agent("Ada");
        const r = await w.showHome();
        await w.agentsArrived(1);
        await enter(r, "/new");
        await way(r, "Browse…");
        await screenShows(r, "work");
        await r.press(KEYS.down);
        await r.press(KEYS.enter);
        await screenShows(r, "locked");
        await r.type("lo");
        await screenShows(r, (screen) => !screen.includes(" lib"));
        await r.press(KEYS.down);
        await r.press(KEYS.enter);
        await screenShows(r, "No permission to read that directory");
        await r.press(KEYS.left);
        // Back in work/, as it was left: filtered to `lo`.
        await screenShows(r, (screen) => !screen.includes("No permission"));
        expect(lineWith(r, "› lo")).toBe("› lo");
        await screenShows(r, "~/work");
      } finally {
        await chmod(join(work, "locked"), 0o755);
      }
    },
    60_000,
  );

  it("makes the project for a directory browsed to, then the conversation, and opens it", async () => {
    const { w, work } = await placesWorld();
    const ada = await w.agent("Ada");
    const r = await w.showHome();
    await w.agentsArrived(1);
    const before = w.conversations().length;
    await enter(r, "/new");
    await way(r, "Browse…");
    await screenShows(r, "work");
    await r.press(KEYS.down); // work
    await r.press(KEYS.enter);
    await screenShows(r, "lib");
    await r.type("lib");
    await screenShows(r, (screen) => !screen.includes("proj"));
    await r.press(KEYS.down); // lib, past "Use this directory"
    await r.press(KEYS.enter);
    await screenShows(r, "~/work/lib");
    await r.press(KEYS.enter); // use it
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
    expect(w.projects().find((p) => p.id === made.projectId)!.path).toBe(
      join(work, "lib"),
    );
    expect(
      askedStarting(w.wire, "conversations.create")[0]?.args,
    ).toMatchObject({
      agentIds: [ada.id],
    });
    await screenShows(r, `1:${made.name.slice(0, 10)}`);
  }, 60_000);
});

describe("/new <path>", () => {
  it("with the path of a project takes that project", async () => {
    const { w, work, proj } = await placesWorld();
    const ada = await w.agent("Ada");
    const r = await w.showHome();
    await w.agentsArrived(1);
    await enter(r, `/new ${join(work, "proj")}`);
    await until(
      () => askedStarting(w.wire, "conversations.create").length === 1,
      10_000,
      "the create",
    );
    expect(askedStarting(w.wire, "projects.create")).toEqual([]);
    expect(askedStarting(w.wire, "conversations.create")[0]?.args).toEqual({
      projectId: proj.id,
      agentIds: [ada.id],
      stewardId: ada.id,
    });
  }, 60_000);

  it("reads ~ as the machine's home: `/new ~/work/lib` is that directory, not a refusal", async () => {
    const { w, work } = await placesWorld();
    await w.agent("Ada");
    const r = await w.showHome();
    await w.agentsArrived(1);
    await enter(r, "/new ~/work/lib");
    await until(
      () => askedStarting(w.wire, "conversations.create").length === 1,
      10_000,
      "the create",
    );
    expect(askedStarting(w.wire, "projects.create")[0]?.args).toMatchObject({
      path: join(work, "lib"),
    });
    expect(plain(r)).not.toContain("absolute");
  }, 60_000);

  it("says a directory that does not exist is not there, and starts nothing", async () => {
    const { w, home } = await placesWorld();
    await w.agent("Ada");
    const r = await w.showHome();
    await w.agentsArrived(1);
    const before = w.conversations().length;
    await enter(r, `/new ${join(home, "nowhere")}`);
    await screenShows(r, "That directory does not exist");
    expect(showsLayer(plain(r))).toBe(true);
    expect(askedStarting(w.wire, "projects.create")).toEqual([]);
    expect(w.conversations()).toHaveLength(before);
  }, 60_000);

  it("asks who next when there are several agents", async () => {
    const { w, work } = await placesWorld();
    const ada = await w.agent("Ada");
    const ben = await w.agent("Ben");
    const r = await w.showHome();
    await w.agentsArrived(2);
    await enter(r, `/new ${join(work, "lib")}`);
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
    expect(askedStarting(w.wire, "projects.create")[0]?.args).toEqual({
      path: join(work, "lib"),
      machineId: w.machines().find((m) => m.kind === "primary")!.id,
    });
    expect(
      askedStarting(w.wire, "conversations.create")[0]?.args,
    ).toMatchObject({ agentIds: [ada.id, ben.id], stewardId: ada.id });
  }, 60_000);
});

describe("/new, a new directory", () => {
  it("chooses where, names it, makes it on the machine and starts there", async () => {
    const { w, home } = await placesWorld();
    await w.agent("Ada");
    const r = await w.showHome();
    await w.agentsArrived(1);
    await enter(r, "/new");
    await way(r, "New directory");
    await screenShows(r, "Where should the new directory go?");
    await search(r, "~/wo", "~/work");
    while (cursorRow(r) !== "~/work") await r.press(KEYS.down);
    await r.press(KEYS.enter);
    await screenShows(r, "Name of the new directory in ~/work");
    await r.type("fresh");
    await screenShows(r, "Create ~/work/fresh");
    await r.press(KEYS.enter);
    await until(
      () => askedStarting(w.wire, "conversations.create").length === 1,
      10_000,
      "the create",
    );
    expect(existsSync(join(home, "work/fresh"))).toBe(true);
    expect(askedStarting(w.wire, "projects.create")[0]?.args).toMatchObject({
      path: join(home, "work/fresh"),
    });
  }, 60_000);
});

describe("/new, cloning", () => {
  it("lists the account's repositories before anything is typed when gh is signed in there", async () => {
    const home = await realpath(await tempDir("eta-tui-home-"));
    const run = async (command: string, args: readonly string[]) => {
      if (command === "git")
        return { code: 0, stdout: "git version 2", stderr: "" };
      if (args[0] === "repo")
        return {
          code: 0,
          stdout: JSON.stringify([
            {
              nameWithOwner: "octocat/Hello-World",
              description: "My first repository",
              updatedAt: null,
              url: "",
            },
          ]),
          stderr: "",
        };
      return { code: 0, stdout: "", stderr: "" };
    };
    const w = await manageWorld(undefined, {
      places: new Places({ home, os: "linux", run }),
    });
    await w.agent("Ada");
    const r = await w.showHome();
    await w.agentsArrived(1);
    await enter(r, "/new");
    await way(r, "Clone from GitHub");
    await screenShows(r, "octocat/Hello-World");
    expect(lineWith(r, "octocat/Hello-World")).toContain("My first repository");
  }, 60_000);

  it("clones a pasted URL into the default place and starts in it", async () => {
    const { w, home } = await placesWorld();
    await w.agent("Ada");
    const origin = join(home, "origin-repo");
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
    await mkdir(join(home, "Developer"));
    const r = await w.showHome();
    await w.agentsArrived(1);
    await enter(r, "/new");
    await way(r, "Clone from GitHub");
    await screenShows(r, "Search repositories, or paste a URL or owner/repo");
    await r.type(`file://${origin}`);
    await screenShows(r, "origin-repo");
    await r.press(KEYS.enter);
    await screenShows(r, "Clone origin-repo into…");
    // Where the last clone went, or ~/Developer the first time: the first line.
    await screenShows(r, "~/Developer/origin-repo");
    expect(cursorRow(r)).toBe("~/Developer/origin-repo");
    await r.press(KEYS.enter);
    await until(
      () => askedStarting(w.wire, "conversations.create").length === 1,
      20_000,
      "the create",
    );
    expect(existsSync(join(home, "Developer/origin-repo/README.md"))).toBe(
      true,
    );
    expect(askedStarting(w.wire, "projects.create")[0]?.args).toMatchObject({
      path: join(home, "Developer/origin-repo"),
    });
  }, 60_000);
});

describe("/new, second step", () => {
  async function three() {
    const w = await manageWorld();
    const ada = await w.agent("Ada");
    const ben = await w.agent("Ben");
    const cleo = await w.agent("Cleo");
    const project = await w.project();
    const r = await w.showHome();
    await w.agentsArrived(3);
    await enter(r, `/new ${project.path}`);
    await screenShows(r, "Space add or drop");
    return { w, r, ada, ben, cleo, project };
  }

  /** Enter, and the conversation the host made of it. */
  async function startIt(
    w: Awaited<ReturnType<typeof three>>["w"],
    r: RenderedApp,
  ) {
    const before = w.conversations().length;
    await r.press(KEYS.enter);
    await until(
      () => newConversations(w, before).length === 1,
      10_000,
      "the new conversation",
    );
    return newConversations(w, before)[0]!;
  }

  it("starts with the first agent checked as steward, then a no-steward line", async () => {
    const { r } = await three();
    expect(lineWith(r, "Ada")).toMatch(/\[x\]\s+Ada\s+steward/);
    expect(lineWith(r, "Ben")).toMatch(/\[ \]\s+Ben$/);
    expect(lineWith(r, "Cleo")).toMatch(/\[ \]\s+Cleo$/);
    expect(lineWith(r, "No steward")).toMatch(/^›?\s*No steward$/);
    const text = layer(r);
    expect(text.indexOf("Cleo")).toBeLessThan(text.indexOf("No steward"));
  }, 60_000);

  it("keeps the first one chosen as steward when more are checked", async () => {
    const { w, r, ada, ben, project } = await three();
    await r.press(KEYS.down);
    await r.press(" "); // Ben checked
    expect(lineWith(r, "Ben")).toMatch(/\[x\]\s+Ben$/);
    expect(lineWith(r, "Ada")).toMatch(/\[x\]\s+Ada\s+steward/);
    const made = await startIt(w, r);
    expect(new Set(made.participants.map((p) => p.agentId))).toEqual(
      new Set([ada.id, ben.id]),
    );
    expect(made.stewardId).toBe(ada.id);
    expect(askedStarting(w.wire, "conversations.create")[0]?.args).toEqual({
      projectId: project.id,
      agentIds: [ada.id, ben.id],
      stewardId: ada.id,
    });
    await screenShows(r, `1:${made.name.slice(0, 10)}`);
  }, 60_000);

  it("makes the one checked first the steward after nobody was checked", async () => {
    const { w, r, ben, cleo, project } = await three();
    await r.press(" "); // Ada dropped: nobody left
    for (const name of ["Ada", "Ben", "Cleo"])
      expect(lineWith(r, name)).not.toMatch(/steward$/);
    await r.press(KEYS.down);
    await r.press(KEYS.down);
    await r.press(" "); // Cleo checked first
    await r.press(KEYS.up);
    await r.press(" "); // then Ben
    expect(lineWith(r, "Cleo")).toMatch(/\[x\]\s+Cleo\s+steward/);
    expect(lineWith(r, "Ben")).toMatch(/\[x\]\s+Ben$/);
    const made = await startIt(w, r);
    expect(made.stewardId).toBe(cleo.id);
    expect(askedStarting(w.wire, "conversations.create")[0]?.args).toEqual({
      projectId: project.id,
      agentIds: [ben.id, cleo.id],
      stewardId: cleo.id,
    });
  }, 60_000);

  it("checks with Space, makes a checked one steward with s, ignores s on an unchecked one", async () => {
    const { w, r, ada, ben, project } = await three();
    await r.press(KEYS.down);
    await r.press(" "); // Ben checked
    await r.press(KEYS.down); // Cleo, unchecked
    await r.press("s");
    expect(lineWith(r, "Cleo")).toMatch(/\[ \]\s+Cleo$/);
    expect(lineWith(r, "Ada")).toMatch(/steward/);
    await r.press(KEYS.up); // Ben
    await r.press("s");
    expect(lineWith(r, "Ben")).toMatch(/\[x\]\s+Ben\s+steward/);
    expect(lineWith(r, "Ada")).toMatch(/\[x\]\s+Ada$/);
    const made = await startIt(w, r);
    expect(made.stewardId).toBe(ben.id);
    expect(askedStarting(w.wire, "conversations.create")[0]?.args).toEqual({
      projectId: project.id,
      agentIds: [ada.id, ben.id],
      stewardId: ben.id,
    });
  }, 60_000);

  it("starts with no steward chosen on the last line", async () => {
    const { w, r, ada, ben, project } = await three();
    await r.press(KEYS.down);
    await r.press(" "); // Ben checked
    await r.press(KEYS.down);
    await r.press(KEYS.down); // No steward
    await r.press("s");
    expect(lineWith(r, "No steward")).toContain("No steward (current)");
    for (const name of ["Ada", "Ben"])
      expect(lineWith(r, name)).not.toMatch(/steward$/);
    const made = await startIt(w, r);
    expect(made.stewardId).toBeNull();
    expect(askedStarting(w.wire, "conversations.create")[0]?.args).toEqual({
      projectId: project.id,
      agentIds: [ada.id, ben.id],
      stewardId: null,
    });
  }, 60_000);

  it("hands the steward to the first checked one left when the steward is dropped", async () => {
    const { w, r, cleo, project } = await three();
    await r.press(KEYS.down);
    await r.press(KEYS.down);
    await r.press(" "); // Cleo checked
    await r.press(KEYS.up);
    await r.press(KEYS.up);
    await r.press(" "); // Ada, the steward, dropped
    expect(lineWith(r, "Ada")).toMatch(/\[ \]\s+Ada$/);
    expect(lineWith(r, "Cleo")).toMatch(/\[x\]\s+Cleo\s+steward/);
    const made = await startIt(w, r);
    expect(made.participants.map((p) => p.agentId)).toEqual([cleo.id]);
    expect(made.stewardId).toBe(cleo.id);
    expect(askedStarting(w.wire, "conversations.create")[0]?.args).toEqual({
      projectId: project.id,
      agentIds: [cleo.id],
      stewardId: cleo.id,
    });
  }, 60_000);

  it("refuses to start with nobody checked", async () => {
    const { w, r } = await three();
    await r.press(" "); // Ada dropped: nobody left
    expect(lineWith(r, "Ada")).toMatch(/\[ \]\s+Ada$/);
    for (const name of ["Ada", "Ben", "Cleo"])
      expect(lineWith(r, name)).not.toMatch(/steward$/);
    await r.press(KEYS.enter);
    await screenShows(r, "Choose at least one member");
    expect(showsLayer(plain(r))).toBe(true);
    expect(askedStarting(w.wire, "conversations.create")).toEqual([]);
  }, 60_000);
});

describe("/new, starting", () => {
  it("sends once while the start is on its way", async () => {
    const w = await manageWorld();
    await w.agent("Ada");
    const project = await w.project();
    const r = await w.showHome();
    await w.agentsArrived(1);
    const held = w.holdOn("conversations.create");
    await enter(r, `/new ${project.path}`);
    await held.asked;
    await screenShows(r, "Starting…");
    await r.press(KEYS.enter);
    await r.press(KEYS.enter);
    await realDelay(50);
    expect(askedStarting(w.wire, "conversations.create")).toHaveLength(1);
    held.release();
    await screenShows(r, (screen) => !showsLayer(screen));
    expect(askedStarting(w.wire, "conversations.create")).toHaveLength(1);
  }, 60_000);

  it("keeps the layer with the error when starting fails, and makes the project only once on a retry", async () => {
    const { w, work } = await placesWorld();
    const ada = await w.agent("Ada");
    const r = await w.showHome();
    await w.agentsArrived(1);
    w.failOn("conversations.create", "the host is busy");
    const before = w.conversations().length;
    await enter(r, `/new ${join(work, "lib")}`);
    await screenShows(r, "the host is busy");
    expect(showsLayer(plain(r))).toBe(true);
    expect(tabBar(r)).not.toContain("1:");
    // Chosen again: the project made the first time is the one used.
    await way(r, "Search directories");
    await search(r, "~/work/lib", "~/work/lib");
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
    await screenShows(r, (screen) => !showsLayer(screen));
    expect(ada.id).toBeTruthy();
  }, 60_000);
});

describe("/new, projects that cannot take a new conversation", () => {
  it("makes a typed path of an archived project again, which brings it back, and starts there", async () => {
    const w = await manageWorld();
    await w.agent("Ada");
    const project = await w.project();
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
    await way(r, "Search directories");
    await search(r, ada.home, `Open ${ada.home}`);
    await r.press(KEYS.enter);
    await screenShows(r, REFUSAL);
    expect(plain(r)).not.toContain("Space add or drop");
    expect(askedStarting(w.wire, "projects.create")).toEqual([]);
  }, 60_000);
});

/** Rows of the main area on an 80×24 terminal: less the status line and the tab bar. */
const MAIN_AREA_80X24 = 22;

/**
 * The layer's frame on screen: its height, whether the lines between it and the status line are
 * blank, and its rows inside the border from the title to the footer.
 */
function layerBox(r: RenderedApp): {
  top: number;
  height: number;
  blankBelow: boolean;
  inside: string[];
} {
  const lines = plain(r).split("\n");
  const top = lines.findIndex((line) => line.startsWith("┌"));
  const bottom = lines.findIndex((line) => line.startsWith("└"));
  const status = lines.findIndex((line) => line.startsWith("Connected"));
  return {
    top,
    height: bottom - top + 1,
    blankBelow: lines
      .slice(bottom + 1, status)
      .every((line) => line.trim() === ""),
    inside: lines
      .slice(top + 1, bottom)
      .map((line) => line.replace(/^│/, "").replace(/│$/, "").trim()),
  };
}

/**
 * The frame holds its content and nothing more: the empty hint row under the title, the content,
 * the empty hint row above the footer, the content's last row right above that.
 */
function expectAsTallAsContent(r: RenderedApp) {
  const { inside, blankBelow, top } = layerBox(r);
  expect(top).toBe(0);
  expect(inside[0]).toBe(TITLE);
  expect(inside[1], plain(r)).toBe("");
  expect(inside.at(-2), plain(r)).toBe("");
  expect(inside.at(-3), plain(r)).not.toBe("");
  expect(blankBelow).toBe(true);
}

describe("/new on an 80×24 terminal", () => {
  const SIZE = { columns: 80, rows: 24 };

  it("the first step's frame is as tall as its rows, the second step's taller with more lines", async () => {
    const w = await manageWorld();
    const names = ["Ada", "Ben", "Cleo", "Dora", "Eli", "Finn"];
    for (const name of names) await w.agent(name);
    const project = await w.project();
    const r = await w.showHome(SIZE);
    await w.agentsArrived(names.length);
    await enter(r, "/new");
    await screenShows(r, "New directory");
    await realDelay(50);
    const first = layerBox(r);
    expect(first.height).toBeLessThan(MAIN_AREA_80X24);
    expectAsTallAsContent(r);

    await r.press(KEYS.enter);
    await search(r, project.name, project.display);
    await r.press(KEYS.enter);
    await screenShows(r, "Space add or drop");
    await realDelay(50);
    const second = layerBox(r);
    expect(second.height).toBeGreaterThan(first.height);
    expect(second.height).toBeLessThan(MAIN_AREA_80X24);
    expectAsTallAsContent(r);
    for (const name of names) expect(lineWith(r, name)).toContain(name);

    // Back to the first step, and back to the ways: the frame shrinks to them again.
    await r.press(KEYS.escape);
    await screenShows(r, "Search by name, or type a path");
    await r.press(KEYS.escape);
    await screenShows(r, "New directory");
    await realDelay(50);
    expect(layerBox(r).height).toBe(first.height);
    expectAsTallAsContent(r);
  }, 60_000);

  it("with more projects than the main area holds, the list opens a window that follows the cursor, the frame within the main area", async () => {
    const w = await manageWorld();
    await w.agent("Ada");
    const projects: ProjectView[] = [];
    for (let i = 0; i < 18; i += 1) projects.push(await w.project());
    const r = await w.showHome(SIZE);
    await w.agentsArrived(1);
    await enter(r, "/new");
    await way(r, "Search directories");
    await screenShows(r, projects.at(-1)!.display);
    await realDelay(50);
    expect(layerBox(r).height).toBeLessThanOrEqual(MAIN_AREA_80X24);
    expectAsTallAsContent(r);
    expect(plain(r).trimEnd().split("\n").length).toBeLessThanOrEqual(24);
    // The oldest is out of the list's window until the cursor gets there.
    const oldest = projects[0]!.display;
    expect(plain(r)).not.toContain(oldest);
    for (let i = 0; i < projects.length - 1; i += 1) await r.press(KEYS.down);
    await screenShows(r, oldest);
    expect(cursorRow(r)).toContain(oldest);
    expect(layerBox(r).height).toBeLessThanOrEqual(MAIN_AREA_80X24);
    expectAsTallAsContent(r);
  }, 120_000);
});
