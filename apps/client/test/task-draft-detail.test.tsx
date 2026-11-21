import { expect, open, test } from "nsh/test";

for (const width of [1440, 390]) {
  test(`reads and closes a legacy draft without confirming it at ${width}px`, async () => {
    const app = await open("./fixtures/draft-conversation.tsx", {
      width,
      height: 844,
      locale: "en-US",
    });
    expect(app.texts()).toContain("Legacy title");
    for (let i = 0; i < 2; i++) {
      await app.press("View details");
      const text = app.texts().join(" ");
      for (const part of [
        "Legacy title",
        "Keep the order.",
        "Read the last item.",
        "Ada (proposer)",
        "starts when ready",
      ])
        expect(text).toContain(part);
      for (const field of ["Dependencies", "Base", "Parent task"])
        expect(app.texts()).not.toContain(field);
      await app.press(width < 600 ? "Back" : "Close");
      expect(app.texts()).toContain("Calls: 0");
    }
    await app.press("Confirm task");
    expect(app.texts()).toContain("Calls: 1");
    expect(app.texts()).toContain(
      'tasks.confirmDraft {"conversationId":"group","messageId":"draft-1"}',
    );
  });
}

test("reads long Markdown and relationship references already in the draft", async () => {
  const app = await open("./fixtures/draft-conversation.tsx", {
    urlScheme: "eta://fixture/rich",
  });
  await app.press("View details");
  const text = app.texts().join(" ");
  for (const part of [
    "Exhibit labels",
    "Paragraph 120",
    "Lin",
    "review/labels",
    "first · Must be done",
    "second · In review or done",
    "parent",
    "Goes to Backlog",
  ])
    expect(text).toContain(part);
});

test("omits absent metadata and labels an empty legacy draft", async () => {
  const app = await open("./fixtures/draft-conversation.tsx", {
    urlScheme: "eta://fixture/empty",
  });
  await app.press("View details");
  expect(app.texts()).toContain("No title provided");
  expect(app.texts()).toContain("No description provided");
  for (const field of [
    "Execution details",
    "Workspace",
    "Executor",
    "Dependencies",
    "Parent task",
  ])
    expect(app.texts()).not.toContain(field);
});
