import { expect, open, test } from "nsh/test";

// A picture a user sent opens large on a press and closes again. (Selecting the text of the bubble
// cannot be driven headless: the test app has no mouse selection, so that is checked in a window.)
const fixture = "./fixtures/user-message.tsx";

test("a sent picture opens large and closes again", async () => {
  const app = await open(fixture, {
    width: 900,
    height: 600,
    locale: "en-US",
    network: {
      "GET http://example.invalid/attachments/a1": {
        headers: { "content-type": "image/png" },
        body: "png",
      },
    },
  });
  await app.waitFor("label:View picture shot.png · 70 B");
  expect(app.shows("label:Close")).toBe(false);
  await app.press("label:View picture shot.png · 70 B");
  await app.waitFor("label:Close");
  await app.press("label:Close");
  expect(app.shows("label:Close")).toBe(false);
});
