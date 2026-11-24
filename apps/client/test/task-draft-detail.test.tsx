import { expect, open, test } from "nsh/test";

for (const width of [1440, 834, 390]) {
  test(`edit and confirm opens the draft without creating a task at ${width}px`, async () => {
    const app = await open("./fixtures/draft-conversation.tsx", {
      width,
      height: 844,
      locale: "en-US",
    });
    expect(app.texts()).toContain("Legacy title");
    // The card offers the form, never a confirmation of its own.
    expect(app.shows("label:Confirm task")).toBe(false);
    expect(app.shows("label:Confirm and start")).toBe(false);
    // Every way out of the form leaves the draft as it was.
    for (const leave of ["label:Cancel", width < 600 ? "Back" : "Close"]) {
      await app.press("label:Edit and confirm");
      expect(app.shows("label:Confirm and start")).toBe(true);
      expect(app.value("label:Title")).toBe("Legacy title");
      // The description shows formatted in its editor.
      expect(app.texts()).toContain("Keep the order.");
      const text = app.texts().join(" ");
      for (const part of ["Ada (proposer)", "starts when ready"])
        expect(text).toContain(part);
      for (const field of ["Dependencies", "Base", "Parent task"])
        expect(app.texts()).not.toContain(field);
      await app.press(leave);
      // The form goes out before it is gone.
      await app.waitUntil(() => !app.shows("label:Confirm and start"));
      expect(app.texts()).toContain("Calls: 0");
    }
    await app.press("label:Edit and confirm");
    await app.keyboard.press("escape");
    expect(app.texts()).toContain("Calls: 0");
  });
}

test("confirming takes the form's own button and sends what was edited", async () => {
  const app = await open("./fixtures/draft-conversation.tsx", {
    locale: "en-US",
  });
  await app.press("label:Edit and confirm");
  await app.type("label:Title", " (edited)");
  await app.press("label:Backlog");
  expect(app.texts()).toContain("Goes to Backlog when confirmed");
  expect(app.texts()).toContain("Calls: 0");
  await app.press("label:Create");
  await app.waitFor("text:Calls: 1");
  expect(app.texts()).toContain(
    'tasks.confirmDraft {"conversationId":"group","messageId":"draft-1","edits":{"title":"Legacy title (edited)","description":"## Scope\\n\\nKeep the order.\\n\\n## Acceptance criteria\\n\\nRead the last item.","status":"backlog"}}',
  );
});

for (const width of [1440, 390]) {
  test(`a confirmed draft's form closes and a toast names the task at ${width}px`, async () => {
    const app = await open("./fixtures/draft-conversation.tsx", {
      width,
      height: 844,
      locale: "en-US",
    });
    await app.press("label:Edit and confirm");
    await app.press("label:Confirm and start");
    await app.waitFor("text:Calls: 1");
    // The row is the task's card before the host's reply comes: the form is
    // gone already, and nothing in its place says the task was made.
    expect(app.shows("text:Confirm task draft")).toBe(false);
    expect(app.shows("label:Confirm and start")).toBe(false);
    expect(app.texts().join(" ")).not.toContain("created as a task");
    await app.press("label:Reply");
    await app.waitFor("text:Task #7 created");
    expect(app.texts()).toContain("Legacy title");
    expect(app.shows("text:Confirm task draft")).toBe(false);
  });
}

test("a draft confirmed into the backlog says so in its toast", async () => {
  const app = await open("./fixtures/draft-conversation.tsx", {
    locale: "en-US",
  });
  await app.press("label:Edit and confirm");
  await app.press("label:Backlog");
  await app.press("label:Create");
  await app.press("label:Reply");
  await app.waitFor("text:Task #7 added to Backlog");
  expect(app.shows("text:Confirm task draft")).toBe(false);
});

test("a confirmation the host refuses keeps the form, what was typed, and says why", async () => {
  const app = await open("./fixtures/draft-conversation.tsx", {
    urlScheme: "eta://fixture/refused",
    locale: "en-US",
  });
  await app.press("label:Edit and confirm");
  await app.type("label:Title", " (edited)");
  await app.press("label:Confirm and start");
  await app.waitFor("text:Could not create the task: no such task: base");
  expect(app.shows("text:Confirm task draft")).toBe(true);
  expect(app.value("label:Title")).toBe("Legacy title (edited)");
  expect(app.enabled("label:Confirm and start")).toBe(true);
  expect(app.shows("text:Task #7 created")).toBe(false);
});

test("an empty title cannot be confirmed", async () => {
  const app = await open("./fixtures/draft-conversation.tsx", {
    urlScheme: "eta://fixture/empty",
    locale: "en-US",
  });
  await app.press("label:Edit and confirm");
  expect(app.value("label:Title")).toBe("");
  expect(app.enabled("label:Confirm and start")).toBe(false);
  for (const field of [
    "Execution details",
    "Workspace",
    "Executor",
    "Dependencies",
    "Parent task",
  ])
    expect(app.texts()).not.toContain(field);
});

test("shows the relationships already in the draft", async () => {
  const app = await open("./fixtures/draft-conversation.tsx", {
    urlScheme: "eta://fixture/rich",
    locale: "en-US",
  });
  await app.press("label:Edit and confirm");
  expect(app.value("label:Title")).toBe("Exhibit labels");
  expect(app.texts()).toContain("Paragraph 1");
  const text = app.texts().join(" ");
  for (const part of [
    "Lin",
    "review/labels",
    "first · Must be done",
    "second · In review or done",
    "parent",
    "Goes to Backlog",
  ])
    expect(text).toContain(part);
  expect(app.shows("label:Create")).toBe(true);
});

test("discarding sends the draft's id and asks nothing first", async () => {
  const app = await open("./fixtures/draft-conversation.tsx", {
    locale: "en-US",
  });
  await app.press("label:Discard");
  await app.waitFor("text:Calls: 1");
  expect(app.texts()).toContain(
    'tasks.discardDraft {"conversationId":"group","messageId":"draft-1"}',
  );
});

test("a discarded draft says so and offers no way to confirm it", async () => {
  const app = await open("./fixtures/draft-conversation.tsx", {
    urlScheme: "eta://fixture/discarded",
    locale: "en-US",
  });
  expect(app.texts()).toContain("Discarded");
  expect(app.texts()).not.toContain("Needs confirming");
  expect(app.shows("label:Edit and confirm")).toBe(false);
  expect(app.shows("label:Discard")).toBe(false);
});

const legacy =
  "Goal: the login page lays out right in Safari.\n\n### Steps\n* reproduce on Safari 18\n* fix `login_form` padding\n\n| browser | ok |\n| --- | --- |\n| Safari | no |\n\n1) keep snake_case names\n2) ship";

test("a description written before opens as its text and, untouched, is confirmed as it was", async () => {
  const app = await open("./fixtures/draft-conversation.tsx", {
    urlScheme: "eta://fixture/legacy",
    locale: "en-US",
  });
  await app.press("label:Edit and confirm");
  // Formatted: the heading and the list items are text of their own, not Markdown source.
  for (const text of ["Steps", "reproduce on Safari 18", "ship"])
    expect(app.texts()).toContain(text);
  expect(app.texts().join(" ")).not.toContain("### Steps");
  await app.press("label:Confirm and start");
  await app.waitFor("text:Calls: 1");
  const call = app
    .texts()
    .find((text) => text.startsWith("tasks.confirmDraft"))!;
  expect(
    JSON.parse(call.slice("tasks.confirmDraft ".length)).edits.description,
  ).toBe(legacy);
});

test("a description written before and edited is kept as Markdown that reads the same", async () => {
  const app = await open("./fixtures/draft-conversation.tsx", {
    urlScheme: "eta://fixture/legacy",
    locale: "en-US",
  });
  await app.press("label:Edit and confirm");
  // A line of its own at the top: ⏎ is a new line, never the confirmation.
  await app.type("label:Description", "Done when it is reviewed");
  await app.keyboard.press("enter");
  expect(app.texts()).toContain("Calls: 0");
  await app.keyboard.press("mod+enter");
  await app.waitFor("text:Calls: 1");
  const call = app
    .texts()
    .find((text) => text.startsWith("tasks.confirmDraft"))!;
  const description = JSON.parse(call.slice("tasks.confirmDraft ".length)).edits
    .description as string;
  expect(description.startsWith("Done when it is reviewed\nGoal:")).toBe(true);
  for (const part of [
    "### Steps",
    "reproduce on Safari 18",
    "`login_form`",
    // The table, which the editor shows as its Markdown, is kept row for row.
    "| browser | ok |\n| --- | --- |\n| Safari | no |",
    "snake_case",
    "Done when it is reviewed",
  ])
    expect(description).toContain(part);
});
