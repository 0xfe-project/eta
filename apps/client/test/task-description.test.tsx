import { expect, open, test } from "nsh/test";

// A task's description is written in the WYSIWYG editor and kept as Markdown: typed Markdown turns
// into formatting, ⏎ is a new line (the form's own button, or ⌘⏎, creates), `@` names an agent,
// and a description written before (an agent's draft) reads back as it was.

const created = (app: Awaited<ReturnType<typeof open>>) =>
  app.texts().find((text) => text.startsWith("Calls: tasks.create")) ?? "";

test("a new task's description is kept as the Markdown typed; ⏎ never creates it", async () => {
  const app = await open("./fixtures/new-task.tsx", { locale: "en-US" });
  await app.type("label:Title", "Divider between artifacts");
  await app.type("label:Description", "## Background");
  await app.keyboard.press("enter");
  await app.type("label:Description", "The panel has no **divider** at all");
  await app.keyboard.press("enter");
  await app.type("label:Description", "- one");
  await app.keyboard.press("enter");
  await app.type("label:Description", "two");
  await app.keyboard.press("enter");
  await app.keyboard.press("enter");
  await app.type("label:Description", "Ask ");
  await app.type("label:Description", "@Li");
  await app.waitFor("label:Mention Lin");
  await app.keyboard.press("enter");
  await app.type("label:Description", "to review");
  expect(created(app)).toBe("");
  await app.keyboard.press("mod+enter");
  await app.waitUntil(() => created(app) !== "");
  const args = JSON.parse(created(app).slice("Calls: tasks.create ".length));
  expect(args.tasks[0].title).toBe("Divider between artifacts");
  expect(args.tasks[0].description).toBe(
    "## Background\n\nThe panel has no **divider** at all\n\n- one\n- two\n\nAsk @Lin to review",
  );
});

test("the Create button takes the description too", async () => {
  const app = await open("./fixtures/new-task.tsx", { locale: "en-US" });
  await app.type("label:Title", "Note");
  await app.type("label:Description", "Use `snake_case` names");
  await app.press("label:Create");
  await app.waitUntil(() => created(app) !== "");
  expect(created(app)).toContain('"description":"Use `snake_case` names"');
});
