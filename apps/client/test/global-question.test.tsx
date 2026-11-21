import { expect, open, test } from "nsh/test";

// The global question dialog shows the whole question: its text, why it was asked, the options, the
// answer box and the send button, on a phone sheet and on the desktop's dialog alike.
const context = "The import job needs a store before Friday";

for (const width of [1440, 1024, 390])
  test(`at ${width}px the question dialog has the question, its context, the options and the answer box`, async () => {
    const app = await open("./fixtures/global-question.tsx", {
      width,
      height: 900,
      locale: "en-US",
      platform: "web",
      storage: { context },
    });
    await app.press("Which database should we use?");
    await app.waitFor("text:Send answer");
    expect(app.shows("Which database should we use?")).toBe(true);
    expect(app.shows(context)).toBe(true);
    expect(app.shows("Postgres")).toBe(true);
    expect(app.shows("SQLite")).toBe(true);
    await app.waitFor("label:Your answer");
  });
