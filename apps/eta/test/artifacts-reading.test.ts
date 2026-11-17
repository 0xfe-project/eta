import type { SessionMeta } from "@eta/server";
/**
 * `search_artifacts` and `read_artifact`: what each kind of session can see, a task's artifacts
 * following the task, out-of-scope artifacts answered as missing, search over titles and text, and
 * reading text by pages, images, binaries and paths that leave the version.
 *
 * The tools run as a session's tool table has them, over a real `ArtifactService` on disk; the
 * board is a map of tasks, so a task can be moved between conversations by hand.
 */
import type { Database } from "bun:sqlite";
import type { TaskBoard } from "../src/tasks/board";
import type { TaskRecord } from "../src/tasks/store";
import { Buffer } from "node:buffer";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_LIMITS } from "../src/artifacts/files";
import { KINDS } from "../src/artifacts/kinds";
import { htmlText, page, scopeOf } from "../src/artifacts/reading";
import { ArtifactService } from "../src/artifacts/service";
import { ArtifactStore } from "../src/artifacts/store";
import { artifactSessionTools } from "../src/artifacts/tools";
import {
  applyMigrations,
  databasePath,
  loadMigrations,
  openDatabase,
} from "../src/db";
import { mentionKey, routineKey, taskKey } from "../src/session-owner";
import { tempDir } from "./support/host";

const open: Database[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

const CAPTAIN = "captain";
const GROUP = "conv-group";
const OTHER = "conv-other";

interface Result {
  content: { type: string; text?: string; data?: string; mimeType?: string }[];
  isError?: boolean;
}

async function bench() {
  const db = openDatabase(databasePath(join(await tempDir(), "data")));
  open.push(db);
  applyMigrations(db, loadMigrations());
  // The rows name tasks and conversations this bench keeps in a map, not in their tables.
  db.exec("PRAGMA foreign_keys = OFF");
  const artifacts = new ArtifactService({
    store: new ArtifactStore(db),
    root: await tempDir(),
    limits: DEFAULT_LIMITS,
    kinds: KINDS,
    key: Buffer.from("key"),
    changed: () => undefined,
  });
  const tasks = new Map<string, TaskRecord>();
  const task = (
    id: string,
    number: number,
    conversationId: string | null,
    originConversationId: string | null = conversationId,
  ): TaskRecord => {
    const made = {
      id,
      number,
      title: `Task ${number}`,
      conversationId,
      originConversationId,
    } as TaskRecord;
    tasks.set(id, made);
    return made;
  };
  const board = {
    find: (ref: string) =>
      tasks.get(ref) ??
      [...tasks.values()].find(
        (t) => `#${t.number}` === ref || `${t.number}` === ref,
      ),
  } as unknown as TaskBoard;
  const table = artifactSessionTools({
    artifacts,
    board,
    limits: DEFAULT_LIMITS,
    taskOfRun: () => undefined,
    isCaptain: (agentId) => agentId === CAPTAIN,
    agentName: (agentId) => ({ ada: "Ada", bob: "Bob" })[agentId],
  });
  /** Call a tool as the session held in `key`, run by `agentId`. */
  const as = (key: string, agentId = "ada") => {
    const tools = table({
      meta: {
        id: "s",
        createdAt: 0,
        cwd: "/",
        agentId,
        conversationId: key,
      } as SessionMeta,
    } as never);
    const run = async (name: string, args: Record<string, unknown>) =>
      (await tools
        .find((tool) => tool.name === name)!
        .execute(args, { turn: 0, toolCallId: "t" })) as Result;
    return {
      search: (args: Record<string, unknown> = {}) =>
        run("search_artifacts", args),
      read: (args: Record<string, unknown>) => run("read_artifact", args),
    };
  };
  const publish = async (
    title: string,
    where: { conversationId?: string; taskId?: string },
    files: Record<string, string | Uint8Array> = {
      "index.html": `<h1>${title}</h1>`,
    },
    publisherAgentId = "ada",
  ) =>
    (
      await artifacts.publish({
        title,
        files: Object.entries(files).map(([name, body]) => ({
          name,
          bytes: typeof body === "string" ? Buffer.from(body) : body,
        })),
        conversationId: where.conversationId,
        taskId: where.taskId,
        publisherAgentId,
      })
    ).artifact;
  return { db, artifacts, tasks, task, as, publish };
}

const textOf = (result: Result): string =>
  result.content.map((part) => part.text ?? "").join("\n");

/** The ids a search lists, in order. */
const ids = (result: Result): string[] =>
  textOf(result)
    .split("\n")
    .filter((line) => / v\d+ · /.test(line))
    .map((line) => line.split(" ")[0]!);

/** A tiny scene: one artifact in each place a scope can reach. */
async function scene() {
  const b = await bench();
  const inGroup = b.task("t-group", 1, GROUP);
  const inOther = b.task("t-other", 2, OTHER);
  const loose = b.task("t-loose", 3, null);
  const group = await b.publish("Group page", { conversationId: GROUP });
  const groupTask = await b.publish("Group task page", {
    conversationId: GROUP,
    taskId: inGroup.id,
  });
  const other = await b.publish("Other page", { conversationId: OTHER });
  const otherTask = await b.publish("Other task page", {
    conversationId: OTHER,
    taskId: inOther.id,
  });
  const looseTask = await b.publish("Loose task page", { taskId: loose.id });
  return {
    ...b,
    inGroup,
    inOther,
    loose,
    a: { group, groupTask, other, otherTask, looseTask },
  };
}

describe("what a session can see", () => {
  it("is everything for Captain, in a conversation and in a routine it runs", async () => {
    const s = await scene();
    const all = Object.values(s.a)
      .map((a) => a.id)
      .sort();
    expect(ids(await s.as(GROUP, CAPTAIN).search()).sort()).toEqual(all);
    expect(ids(await s.as(routineKey("r1"), CAPTAIN).search()).sort()).toEqual(
      all,
    );
  });

  it("is the conversation's own and its tasks' for an agent in it", async () => {
    const s = await scene();
    expect(ids(await s.as(GROUP).search()).sort()).toEqual(
      [s.a.group.id, s.a.groupTask.id].sort(),
    );
    expect(ids(await s.as(OTHER, "bob").search()).sort()).toEqual(
      [s.a.other.id, s.a.otherTask.id].sort(),
    );
  });

  it("is the task's conversation for a task's session, its executor's or a mentioned agent's", async () => {
    const s = await scene();
    const expected = [s.a.group.id, s.a.groupTask.id].sort();
    expect(ids(await s.as(taskKey(s.inGroup.id)).search()).sort()).toEqual(
      expected,
    );
    expect(
      ids(await s.as(mentionKey(s.inGroup.id, "bob"), "bob").search()).sort(),
    ).toEqual(expected);
  });

  it("is only its own for a task in no conversation", async () => {
    const s = await scene();
    expect(ids(await s.as(taskKey(s.loose.id)).search())).toEqual([
      s.a.looseTask.id,
    ]);
  });

  it("is only its own for a task unlinked from the group it came from, and the group no longer sees it", async () => {
    const s = await scene();
    // Proposed in the group, then unlinked (`board.link(id, null)`): the origin stays.
    const unlinked = s.task("t-unlinked", 5, null, GROUP);
    const own = await s.publish("Unlinked task page", {
      conversationId: GROUP,
      taskId: unlinked.id,
    });
    expect(ids(await s.as(taskKey(unlinked.id)).search())).toEqual([own.id]);
    expect(
      (await s.as(taskKey(unlinked.id)).read({ artifactId: s.a.group.id }))
        .isError,
    ).toBe(true);
    expect(ids(await s.as(GROUP).search()).sort()).toEqual(
      [s.a.group.id, s.a.groupTask.id].sort(),
    );
    expect(textOf(await s.as(GROUP).read({ artifactId: own.id }))).toBe(
      `no such artifact: ${own.id}`,
    );
  });

  it("is nothing for a routine that is not Captain's, or a task that is gone", async () => {
    const s = await scene();
    expect(textOf(await s.as(routineKey("r1"), "ada").search())).toBe(
      "No artifacts.",
    );
    expect(textOf(await s.as(taskKey("t-gone")).search())).toBe(
      "No artifacts.",
    );
    expect(
      scopeOf(routineKey("r1"), "ada", {
        isCaptain: () => false,
        findTask: () => undefined,
        taskOfRun: () => undefined,
      }),
    ).toEqual({ kind: "none" });
  });

  it("follows a task to the conversation it moves to", async () => {
    const s = await scene();
    s.tasks.set(s.inGroup.id, { ...s.inGroup, conversationId: OTHER });
    expect(ids(await s.as(GROUP).search())).toEqual([s.a.group.id]);
    expect(ids(await s.as(OTHER).search()).sort()).toEqual(
      [s.a.other.id, s.a.otherTask.id, s.a.groupTask.id].sort(),
    );
    // The moved task's own session now looks from the other conversation.
    expect(ids(await s.as(taskKey(s.inGroup.id)).search()).sort()).toEqual(
      [s.a.other.id, s.a.otherTask.id, s.a.groupTask.id].sort(),
    );
    expect(
      (await s.as(GROUP).read({ artifactId: s.a.groupTask.id })).isError,
    ).toBe(true);
  });

  it("answers an artifact out of scope, by id or by title, as one that does not exist", async () => {
    const s = await scene();
    const group = s.as(GROUP);
    const byId = await group.read({ artifactId: s.a.other.id });
    const missing = await group.read({ artifactId: "no-such-id" });
    expect(byId).toMatchObject({ isError: true });
    expect(textOf(byId)).toBe(`no such artifact: ${s.a.other.id}`);
    expect(textOf(missing)).toBe("no such artifact: no-such-id");
    const byTitle = await group.read({ artifactId: "Other page" });
    expect(textOf(byTitle)).toBe("no such artifact: Other page");
    expect(textOf(await group.search({ query: "Other" }))).toBe(
      'No artifact matches "Other".',
    );
    // In scope, the title finds it.
    expect(textOf(await group.read({ artifactId: "Group page" }))).toContain(
      `Artifact ${s.a.group.id} "Group page"`,
    );
  });

  it("narrows to a task within the scope", async () => {
    const s = await scene();
    expect(ids(await s.as(GROUP).search({ task: "#1" }))).toEqual([
      s.a.groupTask.id,
    ]);
    // A task out of scope is answered the same as one that does not exist.
    expect(await s.as(GROUP).search({ task: "#2" })).toMatchObject({
      isError: true,
      content: [{ text: "no such task: #2" }],
    });
    expect(await s.as(GROUP).search({ task: "#99" })).toMatchObject({
      isError: true,
      content: [{ text: "no such task: #99" }],
    });
    expect(ids(await s.as(GROUP, CAPTAIN).search({ task: "#2" }))).toEqual([
      s.a.otherTask.id,
    ]);
  });
});

describe("search_artifacts", () => {
  it("matches titles and the newest version's text, ignoring case, and not the markup", async () => {
    const b = await bench();
    const t = b.task("t1", 7, GROUP);
    const byTitle = await b.publish("Pricing plan", { conversationId: GROUP });
    const byBody = await b.publish(
      "Notes",
      { conversationId: GROUP, taskId: t.id },
      {
        "index.html":
          '<html><head><style>.pricing{color:red}</style><script>var pricing=1</script></head><body class="pricing"><p>Our <b>PRICING</b> table</p></body></html>',
      },
    );
    const markupOnly = await b.publish(
      "Markup",
      { conversationId: GROUP },
      {
        "index.html":
          '<div class="pricing" data-pricing="x"><style>.pricing{}</style><script>pricing()</script>nothing here</div>',
      },
    );
    const inMarkdown = await b.publish(
      "Doc",
      { conversationId: GROUP },
      {
        "index.html": "<p>x</p>",
        "notes/readme.md": "See the pricing section",
      },
    );
    const result = textOf(await b.as(GROUP).search({ query: "pricing" }));
    const found = ids({ content: [{ type: "text", text: result }] });
    // Title matches first, then text matches, newest first within each.
    expect(found).toEqual([byTitle.id, inMarkdown.id, byBody.id]);
    expect(found).not.toContain(markupOnly.id);
    const line = result.split("\n").find((l) => l.startsWith(byBody.id))!;
    expect(line).toContain('"Notes" v1');
    expect(line).toContain("by Ada");
    expect(line).toContain("task #7 Task 7");
    expect(line).toContain("matched index.html: Our PRICING table");
    expect(result).toContain("notes/readme.md: See the pricing section");
  });

  it("searches only the newest version, and skips a file over 1 MB", async () => {
    const b = await bench();
    const a = await b.publish(
      "A",
      { conversationId: GROUP },
      { "index.html": "<p>old words</p>" },
    );
    await b.artifacts.publish({
      title: "A",
      artifactId: a.id,
      files: [{ name: "index.html", bytes: Buffer.from("<p>new words</p>") }],
      publisherAgentId: "ada",
    });
    await b.publish(
      "Big",
      { conversationId: GROUP },
      {
        "index.html": "<p>x</p>",
        "big.txt": `needle ${"x".repeat(1024 * 1024)}`,
      },
    );
    const group = b.as(GROUP);
    expect(textOf(await group.search({ query: "old words" }))).toBe(
      'No artifact matches "old words".',
    );
    expect(ids(await group.search({ query: "new words" }))).toEqual([a.id]);
    expect(textOf(await group.search({ query: "needle" }))).toBe(
      'No artifact matches "needle".',
    );
  });

  it("lists the newest first without a query, up to the limit, at most 50", async () => {
    const b = await bench();
    for (let i = 0; i < 55; i++)
      await b.publish(`A${i}`, { conversationId: GROUP });
    expect(ids(await b.as(GROUP).search({ limit: 2 }))).toHaveLength(2);
    expect(ids(await b.as(GROUP).search())).toHaveLength(20);
    expect(ids(await b.as(GROUP).search({ limit: 500 }))).toHaveLength(50);
  });

  it("reads the words out of HTML", () => {
    expect(
      htmlText(
        "<!-- hidden --><style>a{}</style><p>Tom &amp; Jerry&#33;</p><script>x()</script>",
      ).trim(),
    ).toBe("Tom & Jerry!");
  });
});

describe("read_artifact", () => {
  const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
    "base64",
  );

  async function site() {
    const b = await bench();
    const t = b.task("t1", 4, GROUP);
    const lines = Array.from({ length: 450 }, (_, i) => `<p>line ${i + 1}</p>`);
    const a = await b.publish(
      "Design",
      { conversationId: GROUP, taskId: t.id },
      {
        "index.html": `${lines.join("\n")}\n`,
        "img/shot.png": PNG,
        "font.woff2": new Uint8Array([0, 1, 2, 3, 0, 255]),
        "app.js": "console.log(1)\n",
      },
    );
    return { ...b, a, read: b.as(GROUP).read };
  }

  it("starts with what the artifact is, and gives the entry page's source by pages", async () => {
    const s = await site();
    const first = textOf(await s.read({ artifactId: s.a.id }));
    expect(first).toContain(`Artifact ${s.a.id} "Design"`);
    expect(first).toContain("Version 1 of 1 (the newest)");
    expect(first).toContain("Publisher: Ada");
    expect(first).toContain("Task: #4 Task 4");
    expect(first).toContain("  img/shot.png (");
    expect(first).toContain("  index.html (");
    // HTML as its source, numbered.
    expect(first).toContain("     1\t<p>line 1</p>");
    expect(first).toContain("   400\t<p>line 400</p>");
    expect(first).not.toContain("<p>line 401</p>");
    expect(first).toContain(
      "(50 more lines after line 400 of 450; read on with offset 401)",
    );
    const next = textOf(await s.read({ artifactId: s.a.id, offset: 401 }));
    expect(next).toContain("   401\t<p>line 401</p>");
    expect(next).toContain("   450\t<p>line 450</p>");
    expect(next).toContain("(end of index.html, 450 lines)");
    const few = textOf(
      await s.read({ artifactId: s.a.id, path: "app.js", limit: 1 }),
    );
    expect(few).toContain("     1\tconsole.log(1)");
    expect(few).toContain("(end of app.js, 1 lines)");
  });

  it("gives an image as an image, and only the size of other binaries", async () => {
    const s = await site();
    const image = await s.read({ artifactId: s.a.id, path: "img/shot.png" });
    expect(image.content[1]).toEqual({
      type: "image",
      data: PNG.toString("base64"),
      mimeType: "image/png",
    });
    const font = textOf(
      await s.read({ artifactId: s.a.id, path: "font.woff2" }),
    );
    expect(font).toContain(
      "font.woff2: a binary file of 6 B; its contents are not shown.",
    );
  });

  it("only gives the size of an image over 5 MB", async () => {
    const b = await bench();
    const a = await b.publish(
      "Huge",
      { conversationId: GROUP },
      {
        "index.html": "<p>x</p>",
        "huge.png": new Uint8Array(5 * 1024 * 1024 + 1),
      },
    );
    const result = await b
      .as(GROUP)
      .read({ artifactId: a.id, path: "huge.png" });
    expect(result.content).toHaveLength(1);
    expect(textOf(result)).toContain("too large to show");
  });

  it("refuses a path out of the version, and says what there is for one that is missing", async () => {
    const s = await site();
    for (const path of ["../../x", "../1/files/index.html", "/etc/passwd"]) {
      const result = await s.read({ artifactId: s.a.id, path });
      expect(result.isError).toBe(true);
    }
    expect(textOf(await s.read({ artifactId: s.a.id, path: "../../x" }))).toBe(
      "not a path inside the artifact: ../../x",
    );
    const missing = await s.read({ artifactId: s.a.id, path: "nope.html" });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain("no file nope.html in version 1");
    expect(textOf(missing)).toContain("  index.html (");
  });

  it("reads an older version, and refuses one that does not exist", async () => {
    const s = await site();
    await s.artifacts.publish({
      title: "Design",
      artifactId: s.a.id,
      files: [{ name: "index.html", bytes: Buffer.from("<p>v2</p>") }],
      publisherAgentId: "ada",
    });
    expect(textOf(await s.read({ artifactId: s.a.id }))).toContain(
      "     1\t<p>v2</p>",
    );
    const old = textOf(await s.read({ artifactId: s.a.id, version: 1 }));
    expect(old).toContain("Version 1 of 2, published");
    expect(old).toContain("<p>line 1</p>");
    expect(textOf(await s.read({ artifactId: s.a.id, version: 9 }))).toBe(
      `no such version: ${s.a.id} has versions 2, 1`,
    );
  });

  it("opens index.html when a version's manifest does not parse", async () => {
    const s = await site();
    s.db.query("UPDATE artifact_version SET manifest = '{broken'").run();
    expect(textOf(await s.read({ artifactId: s.a.id }))).toContain(
      "     1\t<p>line 1</p>",
    );
  });

  it("cuts a very long line", () => {
    const shown = page(`${"x".repeat(2500)}\nshort`, 1, 400);
    expect(shown.text).toContain("… (500 more characters on this line)");
    expect(shown.text).toContain("     2\tshort");
  });
});
