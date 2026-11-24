import { expect, open, test } from "nsh/test";

// A question a task's run asked is on no reply in the chat: the task is where it is answered, on
// its page at every size and in the chat's task panel.
const fixture = "./fixtures/task-question.tsx";

const places = [
  ["the desktop page", 1440, 900, undefined],
  ["the tablet page", 1024, 768, undefined],
  ["the phone page", 390, 844, undefined],
  ["the chat's task panel", 1440, 900, "eta://fixture/panel"],
] as const;

for (const [name, width, height, urlScheme] of places)
  test(`a task's question is answered on ${name}`, async () => {
    const app = await open(fixture, {
      width,
      height,
      locale: "en-US",
      platform: "web",
      urlScheme,
    });
    await app.waitFor("text:Which branch should I cut?");
    await app.press("label:release/0.9");
    await app.waitUntil(() =>
      app.texts().some((text) => text.includes('"release/0.9"')),
    );
    expect(app.texts().some((text) => text.includes('"id":"q-task"'))).toBe(
      true,
    );
    // Answered, the card goes.
    await app.waitUntil(() => !app.shows("text:Which branch should I cut?"));
  });
