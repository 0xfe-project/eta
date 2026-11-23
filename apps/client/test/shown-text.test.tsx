import type { App } from "nsh/test";
import { expect, open, test } from "nsh/test";

// Shown text is the chat's text system's view (nsh TextView) with the view half of its plugins: a
// message shows its blocks as they were written, they do what they do where it is read, and
// Settings › Appearance › Images in messages decides whether a picture is its name in the text or a
// card under it.

const fixture = "./fixtures/shown-text.tsx";
const picture = { headers: { "content-type": "image/png" }, body: "png" };
const network = {
  "GET http://example.invalid/attachments/p1": picture,
  "GET http://example.invalid/attachments/p2": picture,
  "GET http://example.invalid/shot.png": picture,
};

const before = "label:View picture before.png · 2.0 KB";
const after = "label:View picture after.png · 3.0 KB";
const shot = "label:View picture shot.png";
const pdf = "label:Save spec.pdf · 84.0 KB";
const cards = (app: App) => app.count("id:picture-card");

const start = (storage?: Record<string, string>) =>
  open(fixture, {
    platform: "macos",
    width: 1400,
    height: 900,
    locale: "en-US",
    network,
    ...(storage ? { storage } : {}),
  });

test("a sent message shows its mention, its folded paste and its files as they were written", async () => {
  const app = await start();
  await app.waitFor(before);
  expect(app.shows("text:@Reviewer")).toBe(true);
  expect(app.shows("text:42 lines")).toBe(true);
  expect(app.texts().join("\n")).not.toContain("line 7");
  expect(app.shows(after)).toBe(true);
  expect(app.shows(pdf)).toBe(true);
  expect(cards(app)).toBe(0);
  // Nothing to take out: a shown block has no ×.
  expect(app.shows("label:Remove pasted text")).toBe(false);
  // A file that is not a picture saves on a press.
  await app.press(pdf);
  await app.waitFor("text:Saved file f1");
  // A folded paste opens on a press, in its place, as its lines. (Pressed in a note: the headless
  // engine places an inline block in the right-aligned bubble off its line; a browser and the
  // desktop app do not.)
  const shown = () => app.texts().join("\n");
  await app.press("label:Note >> label:Unfold pasted text (42 lines)");
  await app.waitUntil(() => shown().includes("line 7"));
  expect(app.count("label:Unfold pasted text (42 lines)")).toBe(1);
});

test("a mention opens its member, and a reply's Markdown picture opens over the window", async () => {
  const app = await start();
  await app.waitFor("label:Open Opus");
  await app.press("label:Open Opus");
  await app.waitFor("text:Opened member agent-opus");
  // The reply's Markdown picture is a chip where it was written; it opens over the window.
  expect(app.shows(shot)).toBe(true);
  await app.press(shot);
  await app.waitFor("id:picture-stage");
  await app.press("label:Close");
  await app.waitUntil(() => !app.shows("id:picture-stage"));
  // The code is a code block, with the view's own Copy.
  expect(app.shows("text:<Row inset={12} />")).toBe(true);
  expect(app.shows("label:Copy code")).toBe(true);
});

test("switching Images in messages to Expanded takes the pictures' names out and shows cards under the text", async () => {
  const app = await start();
  await app.waitFor(before);
  await app.press("label:Images in messages");
  await app.press("text:Expanded");
  await app.waitUntil(() => cards(app) === 3);
  expect(app.shows(before)).toBe(true);
  expect(app.shows("text:before.png · 2.0 KB")).toBe(true);
  // No picture is a chip in the text any more; the PDF still is.
  expect(app.count("label:View picture before.png · 2.0 KB")).toBe(1);
  expect(app.shows(pdf)).toBe(true);
  expect(app.shows("text:42 lines")).toBe(true);
  // A card opens the picture, and the lightbox walks through the message's pictures.
  await app.press(after);
  await app.waitFor("text:2 / 2 · after.png · 3.0 KB");
  await app.press("label:Close");
  // Back to Compact: the names are in the text again.
  await app.press("label:Images in messages");
  await app.press("text:Compact");
  await app.waitUntil(() => cards(app) === 0);
  expect(app.shows(before)).toBe(true);
});

test("the choice is kept on the device", async () => {
  const app = await start({ "eta.messages.pictures": "expanded" });
  await app.waitUntil(() => cards(app) === 3);
  expect(app.shows("text:Expanded")).toBe(true);
});

test("a reply being written shows each chunk as it comes, then the whole of it", async () => {
  const app = await start();
  await app.waitFor("label:Streaming reply");
  expect(app.shows("text:Working on it")).toBe(true);
  await app.press("label:More");
  await app.waitFor("text:step two");
  // The code block it is in the middle of shows what there is of it.
  expect(app.shows("text:const a")).toBe(true);
  await app.press("label:Done");
  await app.waitFor("text:All done.");
  expect(app.shows("text:const a = 1;")).toBe(true);
});
