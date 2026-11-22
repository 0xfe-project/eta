import { expect, open, test } from "nsh/test";

for (const width of [1440, 390]) {
  test(`the stop on a member chip stays with the reply at ${width}px`, async () => {
    const app = await open("./fixtures/member-replies.tsx", { width });
    const stop = "Stop Ada";
    expect(app.enabled("Stop Lin")).toBe(true);
    await app.press("Lin");
    expect(app.texts()).toContain("Waits until Lin finishes this turn");
    await app.press(stop);
    expect(app.enabled(stop)).toBe(false);
    expect(app.texts()).toContain("Waits until Lin finishes this turn");
    expect(app.enabled("Stop Lin")).toBe(true);
    const first =
      'conversations.stop {"conversationId":"group","messageId":"ada-1"}';
    expect(app.texts()).toContain(first);
    await app.press("Finish Ada");
    expect(app.shows(stop)).toBe(false);
    await app.press("Another Ada reply");
    await app.press("Deliver stop response");
    expect(app.enabled(stop)).toBe(true);
    expect(app.texts()).toContain(first);
    await app.press(stop);
    expect(app.texts()).toContain(
      [
        first,
        'conversations.stop {"conversationId":"group","messageId":"ada-2"}',
      ].join("\n"),
    );
  });
}

test("the desktop composer has no stop of its own; each member chip stops its reply", async () => {
  const app = await open("./fixtures/member-replies.tsx", { width: 1440 });
  expect(app.shows("Stop")).toBe(false);
  expect(app.enabled("Stop Ada")).toBe(true);
  expect(app.enabled("Stop Lin")).toBe(true);
});
