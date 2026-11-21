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
  // Their own lines, open.
  expect(
    texts.some((t) => t.includes("added prerequisite “Design the login flow”")),
  ).toBe(true);
  expect(
    texts.some((t) => t.includes("published artifact “Login API benchmark”")),
  ).toBe(true);
  expect(
    texts.some((t) =>
      t.includes("This turn failed: the provider returned 529"),
    ),
  ).toBe(true);
  expect(
    texts.some((t) =>
      t.includes("was blocked: “Design the login flow” was cancelled"),
    ),
  ).toBe(true);
  // Status changes, run bookkeeping and the rename are folded, each run of them into one line.
  expect(texts.some((t) => t.includes("changed status from"))).toBe(false);
  expect(texts.some((t) => t.includes("renamed it to"))).toBe(false);
  expect(texts.filter((t) => /^\d+ updates?$/.test(t))).toEqual([
    "1 update",
    "1 update",
    "2 updates",
    "3 updates",
  ]);
  // Nothing says the task was created or a run was queued, and a run still going is not in it.
  expect(texts.some((t) => t.includes("created this task"))).toBe(false);
  expect(texts.some((t) => t.includes("queued a run"))).toBe(false);

  // A fold opens in place and closes again.
  await app.press("label:3 updates");
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
  await app.press("label:3 updates");
  expect(app.texts().some((t) => t.includes("renamed it to"))).toBe(false);
});

test("a sender's comments in a row share one face and name", async () => {
  const app = await open(fixture, {
    width: 1440,
    height: 2400,
    locale: "en-US",
  });
  await app.waitUntil(() => app.texts().includes("Lax."));
  // "Me" heads the two comments a minute apart once, and the later one on its own; the third
  // "Me" is the prerequisite line's.
  expect(app.texts().filter((t) => t === "Me")).toHaveLength(3);
});
