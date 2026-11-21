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
      expect(app.value("label:Description")).toContain("Keep the order.");
      const text = app.texts().join(" ");
      for (const part of ["Ada (proposer)", "starts when ready"])
        expect(text).toContain(part);
      for (const field of ["Dependencies", "Base", "Parent task"])
        expect(app.texts()).not.toContain(field);
      await app.press(leave);
      expect(app.shows("label:Confirm and start")).toBe(false);
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
  expect(app.value("label:Description")).toContain("Paragraph 120");
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
