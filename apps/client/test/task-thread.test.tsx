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
  expect(
    texts.some((t) =>
      t.includes("This turn failed: the provider returned 529"),
    ),
  ).toBe(true);
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
