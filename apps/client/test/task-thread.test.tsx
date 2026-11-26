import { expect, open, test } from "nsh/test";

const fixture = "./fixtures/task-thread.tsx";

test("the user's own comments show, open, in the task panel's thread", async () => {
  const app = await open(fixture, {
    width: 1440,
    height: 2400,
    locale: "en-US",
  });
  await app.waitUntil(() => app.texts().includes("Lax."));
  const texts = app.texts();
  // Every comment is a message of its own, never behind a fold: the user's, an agent's, Captain's.
  expect(texts).toContain("Lax.");
  expect(texts).toContain("And keep the cookie name eta_session.");
  expect(texts).toContain("Looks good. I'll check the benchmark tonight.");
  expect(texts).toContain("Should the session cookie be Lax or Strict?");
  expect(texts).toContain("Review: add a per-IP rate limit.");
  expect(texts).toContain("5 replies");
});

test("delivered, failed and dependency lines stand alone; the rest folds between them", async () => {
  const app = await open(fixture, {
    width: 1440,
    height: 2400,
    locale: "en-US",
  });
  await app.waitUntil(() => app.texts().includes("Lax."));
  const texts = app.texts();
  // A line's target is a text of its own, so its sentence reads across them.
  const said = texts.join("");
  // Their own lines, open.
  expect(said).toContain("added prerequisite “Design the login flow”");
  expect(said).toContain("published artifact “Login API benchmark”");
  expect(texts.includes("This turn failed.")).toBe(true);
  expect(said).toContain("was blocked: “Design the login flow” was cancelled");
  // Status changes, run bookkeeping and the rename are folded, each run of them into one line.
  expect(texts.some((t) => t.includes("changed status from"))).toBe(false);
  expect(texts.some((t) => t.includes("renamed it to"))).toBe(false);
  expect(texts.filter((t) => /^\d+ updates?$/.test(t))).toEqual([
    "1 update",
    "1 update",
    "2 updates",
    "5 updates",
  ]);
  // Nothing says the task was created or a run was queued, and a run still going is not in it.
  expect(texts.some((t) => t.includes("created this task"))).toBe(false);
  expect(texts.some((t) => t.includes("queued a run"))).toBe(false);

  // A fold opens in place and closes again.
  await app.press("label:5 updates");
  expect(
    app.texts().some((t) => t.includes("renamed it to “Build the login API”")),
  ).toBe(true);
  expect(
    app
      .texts()
      .some((t) =>
        t.includes("changed status from “In review” to “In progress”"),
      ),
  ).toBe(true);
  await app.press("label:5 updates");
  expect(app.texts().some((t) => t.includes("renamed it to"))).toBe(false);
});

test("a sender's comments in a row share one face and name", async () => {
  const app = await open(fixture, {
    width: 1440,
    height: 2400,
    locale: "en-US",
  });
  await app.waitUntil(() => app.texts().includes("Lax."));
  // "Me" heads the two comments a minute apart once, and the later one on its own; the other
  // three are the prerequisite lines'.
  expect(app.texts().filter((t) => t === "Me")).toHaveLength(5);
});

test("a prerequisite's title goes to that task, an old entry's found by its number", async () => {
  const app = await open(fixture, {
    width: 1440,
    height: 2400,
    locale: "en-US",
  });
  await app.waitUntil(() => app.texts().includes("Lax."));
  // Added as a prerequisite, then the reason the task was blocked: both lines go there.
  expect(app.count("label:Open task #1 “Design the login flow”")).toBe(2);
  await app.press("label:Open task #1 “Design the login flow” >> nth=1");
  expect(app.texts()).toContain("opened task t1");
  // Written before the host kept ids; #3 is archived, and still opens.
  await app.press("label:Open task #3 “Pick a session store”");
  expect(app.texts()).toContain("opened task t3");
});

test("the parent and a subtask named in the timeline go to those tasks", async () => {
  const app = await open(fixture, {
    width: 1440,
    height: 2400,
    locale: "en-US",
  });
  await app.waitUntil(() => app.texts().includes("Lax."));
  await app.press("label:5 updates");
  await app.press("label:Open task #2 “Ship sign-in”");
  expect(app.texts()).toContain("opened task t2");
  await app.press("label:Open task #5 “Write the login API tests”");
  expect(app.texts()).toContain("opened task t5");
});

test("an artifact's title opens the version it was published as", async () => {
  const app = await open(fixture, {
    width: 1440,
    height: 2400,
    locale: "en-US",
  });
  await app.waitUntil(() => app.texts().includes("Lax."));
  await app.press("label:Open artifact “Login API benchmark”");
  expect(app.texts()).toContain("opened artifact art v1");
});

test("a deleted artifact or task is named but cannot be opened", async () => {
  const app = await open(fixture, {
    width: 1440,
    height: 2400,
    locale: "en-US",
  });
  await app.waitUntil(() => app.texts().includes("Lax."));
  const said = app.texts().join("");
  expect(said).toContain("published artifact “Early benchmark draft”");
  expect(app.texts()).toContain("(deleted)");
  expect(said).toContain("added prerequisite “Draft the old login copy”");
  expect(app.count("label:Open artifact “Early benchmark draft”")).toBe(0);
  expect(app.count("label:Open task #9 “Draft the old login copy”")).toBe(0);
});

const narrowFixture = "./fixtures/task-thread-narrow.tsx";
const longTitle = "Revert PR #957 (Antigravity ACP auto-discovery & preset)";
const deletedArtifactTitle =
  "Old draft (Antigravity ACP auto-discovery & preset)";
const deletedTaskTitle =
  "Removed PR #958 (Antigravity ACP auto-discovery & preset)";

test("narrow zh panel keeps quotes attached to long target titles and preserves link interaction", async () => {
  const app = await open(narrowFixture, {
    width: 360,
    height: 900,
    locale: "zh-CN",
    platform: "macos",
  });
  await app.waitUntil(() =>
    app.texts().some((t) => t.includes(`添加了前置任务「${longTitle}」`)),
  );
  await app.wait(50);
  const texts = app.texts();
  expect(texts).toContain(`添加了前置任务「${longTitle}」`);
  expect(texts).toContain(`被阻塞：「${longTitle}」已取消`);
  expect(texts).toContain(`发布了产物「${longTitle}」`);
  expect(texts).toContain(`发布了产物「${deletedArtifactTitle}」`);
  expect(texts).toContain(`添加了前置任务「${deletedTaskTitle}」`);
  expect(texts).toContain("（已删除）");
  expect(texts).not.toContain("添加了前置任务「");
  expect(texts).not.toContain("」");
  expect(texts).not.toContain("」已取消");

  const taskLabel = `label:打开任务 #957「${longTitle}」`;
  const artifactLabel = `label:打开产物「${longTitle}」`;
  expect(app.count(taskLabel)).toBe(2);
  expect(app.count(artifactLabel)).toBe(1);
  expect(app.count(`label:打开产物「${deletedArtifactTitle}」`)).toBe(0);
  expect(app.count(`label:打开任务 #958「${deletedTaskTitle}」`)).toBe(0);
  expect(app.accessibility(`${taskLabel} >> nth=0`)).toMatchObject({
    role: "link",
    label: `打开任务 #957「${longTitle}」`,
  });

  const actorLayout = app.layout("text:我 >> nth=0")!;
  const sentenceLayout = app.layout(`${taskLabel} >> nth=0`)!;
  expect(sentenceLayout.x + sentenceLayout.width).toBeLessThanOrEqual(360);
  expect(sentenceLayout.height).toBeLessThanOrEqual(42);
  expect(sentenceLayout.y).toBe(actorLayout.y);

  const spanSelector = `${artifactLabel} >> text:${longTitle}`;
  expect(app.spanStyle(spanSelector)).toMatchObject({
    color: "#111111ff",
    underline: false,
  });
  await app.hover(spanSelector);
  expect(app.spanStyle(spanSelector)).toMatchObject({
    color: "#006cb5ff",
    underline: true,
  });

  await app.press(`${taskLabel} >> nth=0`);
  expect(app.texts()).toContain("opened task t957");
  await app.press(spanSelector);
  expect(app.texts()).toContain("opened artifact art-long v1");
});

test("narrow en panel keeps quotes and suffixes inline around long target titles", async () => {
  const app = await open(narrowFixture, {
    width: 320,
    height: 900,
    locale: "en-US",
    platform: "macos",
  });
  await app.waitUntil(() =>
    app.texts().some((t) => t.includes(`added prerequisite “${longTitle}”`)),
  );
  await app.wait(50);
  const texts = app.texts();
  expect(texts).toContain(`added prerequisite “${longTitle}”`);
  expect(texts).toContain(`was blocked: “${longTitle}” was cancelled`);
  expect(texts).toContain(`published artifact “${longTitle}”`);
  expect(texts).toContain(`published artifact “${deletedArtifactTitle}”`);
  expect(texts).toContain(`added prerequisite “${deletedTaskTitle}”`);
  expect(texts).toContain("(deleted)");
  expect(texts).not.toContain("added prerequisite “");
  expect(texts).not.toContain("”");
  expect(texts).not.toContain("” was cancelled");

  const taskLabel = `label:Open task #957 “${longTitle}”`;
  expect(app.count(taskLabel)).toBe(2);
  expect(app.count(`label:Open artifact “${deletedArtifactTitle}”`)).toBe(0);
  expect(app.count(`label:Open task #958 “${deletedTaskTitle}”`)).toBe(0);

  const actorLayout = app.layout("text:Me >> nth=0")!;
  const sentenceLayout = app.layout(`${taskLabel} >> nth=0`)!;
  expect(sentenceLayout.x + sentenceLayout.width).toBeLessThanOrEqual(320);
  expect(sentenceLayout.height).toBeLessThanOrEqual(42);
  expect(sentenceLayout.y).toBe(actorLayout.y);

  await app.press(`${taskLabel} >> nth=1`);
  expect(app.texts()).toContain("opened task t957");
});
