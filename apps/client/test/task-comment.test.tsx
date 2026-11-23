import { expect, open, test } from "nsh/test";

// Every task takes a comment, as on the web: what it then does is the host's (a task not running
// is woken to carry on, a running one reads it in the run that is going, a task not worked on any
// more or a parent only keeps it). A parent says over its box that its comment starts no run.
const fixture = "./fixtures/task-comment.tsx";

const surfaces = [
  ["panel", 1440],
  ["page", 1440],
  ["page", 1024],
  ["page", 390],
] as const;

const states = [
  "in_review",
  "done",
  "blocked",
  "backlog",
  "cancelled",
  "archived",
  "waiting",
  "running",
  "parent",
] as const;

const parentHint = "Discuss here; to change a step, say so on that subtask";

async function openOn(surface: string, width: number, state: string) {
  const app = await open(fixture, {
    width,
    height: 900,
    locale: "en-US",
    platform: "web",
    storage: { surface, state },
  });
  await app.waitFor("text:Build the login API");
  return app;
}

for (const [surface, width] of surfaces)
  for (const state of states)
    test(`${surface} at ${width}px: a task that is ${state} takes a comment`, async () => {
      const app = await openOn(surface, width, state);
      const body = `A note on the ${state} task`;
      await app.type("label:Comment", body);
      await app.keyboard.press("mod+enter");
      await app.waitUntil(() =>
        app.texts().includes(`Sent: tasks.comment t2 ${body}`),
      );
      // On its timeline, once.
      await app.waitFor(`text:${body}`);
      expect(app.texts().filter((text) => text === body)).toHaveLength(1);
      // The parent's line shows on a parent only.
      expect(app.texts().includes(parentHint)).toBe(state === "parent");
    });

for (const [surface, width] of surfaces)
  test(`${surface} at ${width}px: no parent's line while its executor's run is going`, async () => {
    // A run of the executor (one splitting the task) reads the comment.
    const app = await openOn(surface, width, "parent-splitting");
    await app.waitFor("label:Comment");
    expect(app.texts()).not.toContain(parentHint);
  });

test("the send button posts the comment too, on a task in review", async () => {
  const app = await openOn("page", 1440, "in_review");
  expect(app.enabled("label:Send comment")).toBe(false);
  await app.type("label:Comment", "One more case");
  expect(app.enabled("label:Send comment")).toBe(true);
  await app.press("label:Send comment");
  await app.waitUntil(() =>
    app.texts().includes("Sent: tasks.comment t2 One more case"),
  );
});

test("a comment is kept as the Markdown typed; ⏎ is a new line, ⌘⏎ posts", async () => {
  const app = await openOn("page", 1440, "in_review");
  await app.type("label:Comment", "Checked on **all** sizes:");
  await app.keyboard.press("enter");
  await app.type("label:Comment", "- desktop");
  await app.keyboard.press("enter");
  await app.type("label:Comment", "phone");
  await app.keyboard.press("enter");
  await app.keyboard.press("enter");
  await app.type("label:Comment", "Run `bun test` again");
  expect(app.texts().some((text) => text.includes("tasks.comment"))).toBe(
    false,
  );
  await app.keyboard.press("mod+enter");
  await app.waitUntil(() =>
    app
      .texts()
      .includes(
        "Sent: tasks.comment t2 Checked on **all** sizes:\n\n- desktop\n- phone\n\nRun `bun test` again",
      ),
  );
});

for (const [surface, width] of surfaces)
  test(`${surface} at ${width}px: @ offers the task's agents first and the comment mentions the one picked`, async () => {
    const app = await openOn(surface, width, "in_review");
    // Ada runs the task; Lin is on the host (listed first there) but not in the task. ⏎ takes
    // the list's first row.
    await app.type("label:Comment", "@");
    await app.waitFor("label:Mention Lin");
    await app.keyboard.press("enter");
    await app.type("label:Comment", "please look");
    await app.press("label:Send comment");
    await app.waitUntil(() =>
      app
        .texts()
        .includes("Sent: tasks.comment t2 @Ada please look mentions=ada"),
    );
  });
