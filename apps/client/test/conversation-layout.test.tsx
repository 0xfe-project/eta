import { expect, open, test } from "nsh/test";

// The conversation page is three blocks: the header, the message area and the
// composer. Whatever the message area holds (the loading skeleton, the empty
// note, an error or a few messages), it holds it inside, and the composer is
// its own block after it rather than part of what the timeline draws. Where
// the blocks land on screen is shown in the PR with a real browser.

const fixture = "./fixtures/conversation-layout.tsx";
const messages = "id:conversation-messages";
const composer = "id:conversation-composer";
const skeleton = "label:Loading conversation…";

const sizes = [
  ["desktop", 1440, 900],
  ["tablet", 834, 1112],
  ["phone", 390, 844],
] as const;

const states = [
  ["loading", skeleton],
  ["empty", "text:No messages yet"],
  ["short", "text:Pong."],
] as const;

for (const [name, width, height] of sizes)
  for (const [scenario, content] of states)
    test(`${scenario}: the message area holds it and the composer comes after (${name})`, async () => {
      const app = await open(fixture, {
        width,
        height,
        locale: "en-US",
        urlScheme: `eta://fixture/${scenario}`,
      });
      expect(app.shows(`${messages} >> ${content}`)).toBe(true);
      expect(app.shows(composer)).toBe(true);
      expect(app.shows(`${messages} >> ${composer}`)).toBe(false);
      expect(app.shows(`${messages} >> ${skeleton}`)).toBe(
        scenario === "loading",
      );
    });

test("a phone that lost the host before any message shows the error in the message area", async () => {
  const app = await open(fixture, {
    width: 390,
    height: 844,
    locale: "en-US",
    urlScheme: "eta://fixture/offline",
    clock: {},
  });
  // Said only once the connection has been gone for the grace period.
  await app.clock!.runFor(2_000);
  expect(
    app.shows(`${messages} >> text:Lost the connection to the host.`),
  ).toBe(true);
  expect(app.shows(skeleton)).toBe(false);
  expect(app.shows(composer)).toBe(true);
  expect(app.shows(`${messages} >> ${composer}`)).toBe(false);
});
