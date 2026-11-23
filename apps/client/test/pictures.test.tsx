import type { App } from "nsh/test";
import { expect, open, test } from "nsh/test";

const SHOT = "6a0d3f0e-0000-4000-8000-000000000001";
const PHOTO = "6a0d3f0e-0000-4000-8000-000000000002";
const NOTES = "6a0d3f0e-0000-4000-8000-000000000003";
const picture = (type: string) => ({
  headers: { "content-type": type },
  body: "picture bytes",
});
const network = {
  [`GET http://example.invalid/attachments/${SHOT}`]: picture("image/png"),
  [`GET http://example.invalid/attachments/${PHOTO}`]: picture("image/jpeg"),
};

const desktop = () =>
  open("./fixtures/pictures.tsx", {
    platform: "macos",
    width: 1024,
    height: 768,
    network,
    // The preview's delay runs on this clock only.
    clock: { time: 1000 },
  });
const phone = () =>
  open("./fixtures/pictures.tsx", { platform: "ios", network });

const shotChip = "label:View picture shot.png · 2.0 KB";
const photoChip = "label:View picture photo.jpg · 3.0 KB";
/** The picture itself, beside its chip or in the lightbox. */
const shot = "label:shot.png · 2.0 KB";
const bar = (text: string) => `text:${text}`;
const attachmentRequests = (app: App) =>
  app.requests().filter((request) => request.url.includes("/attachments/"));

test("sent pictures are fetched once, with the host's token; a file that is not a picture is a chip that saves", async () => {
  const app = await desktop();
  await app.waitUntil(() => attachmentRequests(app).length === 2);
  const requests = attachmentRequests(app);
  expect(requests.map((request) => request.url).sort()).toEqual(
    [SHOT, PHOTO]
      .map((id) => `http://example.invalid/attachments/${id}`)
      .sort(),
  );
  for (const request of requests)
    expect(request.headers.authorization).toBe("Bearer secret");
  expect(app.shows("label:Save notes.txt · 1.0 KB")).toBe(true);
  expect(app.shows("label:View picture notes.txt · 1.0 KB")).toBe(false);
  expect(app.shows(shotChip)).toBe(true);
  // Opening and previewing read the copy the chip fetched: nothing is asked for again.
  await app.hover(shotChip);
  await app.wait(350);
  await app.press(shotChip);
  await app.waitFor(bar("1 / 2 · shot.png · 2.0 KB"));
  expect(attachmentRequests(app).length).toBe(2);
  expect(requests.some((request) => request.url.endsWith(NOTES))).toBe(false);
});

test("resting the mouse on a picture's chip shows the picture after 300ms, and leaving hides it", async () => {
  const app = await desktop();
  await app.waitUntil(() => attachmentRequests(app).length === 2);
  expect(app.shows(shot)).toBe(false);
  await app.hover(shotChip);
  await app.wait(200);
  expect(app.shows(shot)).toBe(false);
  await app.wait(150);
  expect(app.shows(shot)).toBe(true);
  expect(app.shows("text:shot.png · 2.0 KB")).toBe(true);
  await app.hover("label:Elsewhere");
  await app.waitUntil(() => !app.shows(shot));
  // A run's picture previews the same way.
  await app.hover("label:Open image 1 of 2");
  await app.wait(350);
  expect(app.shows("text:PNG · 1 KB")).toBe(true);
});

test("a picture opens over the window, fitted; the arrows and the bar walk through the message's pictures; Escape and Close close it", async () => {
  const app = await desktop();
  await app.press(shotChip);
  await app.waitFor(bar("1 / 2 · shot.png · 2.0 KB"));
  expect(app.enabled("label:Previous")).toBe(false);
  await app.keyboard.press("right");
  await app.waitFor(bar("2 / 2 · photo.jpg · 3.0 KB"));
  expect(app.enabled("label:Next")).toBe(false);
  await app.keyboard.press("right");
  expect(app.shows(bar("2 / 2 · photo.jpg · 3.0 KB"))).toBe(true);
  await app.keyboard.press("left");
  await app.waitFor(bar("1 / 2 · shot.png · 2.0 KB"));
  await app.press("label:Next");
  await app.waitFor(bar("2 / 2 · photo.jpg · 3.0 KB"));
  // A press shows it at its own size, another fits it again.
  await app.press("id:picture-stage");
  expect(app.shows("id:picture-stage")).toBe(true);
  await app.press("id:picture-stage");
  await app.keyboard.press("escape");
  await app.waitUntil(() => !app.shows(bar("2 / 2 · photo.jpg · 3.0 KB")));
  // Opened from the second chip, it starts at the second picture; Close closes it.
  await app.press(photoChip);
  await app.waitFor(bar("2 / 2 · photo.jpg · 3.0 KB"));
  await app.press("label:Close");
  await app.waitUntil(() => !app.shows("id:picture-stage"));
  // A run's pictures open in their own lightbox.
  await app.press("label:Open image 2 of 2");
  await app.waitFor(bar("2 / 2 · PNG · 1 KB"));
  await app.keyboard.press("left");
  await app.waitFor(bar("1 / 2 · PNG · 1 KB"));
});

test("on a touch screen nothing previews: a tap opens the lightbox, a swipe walks through it", async () => {
  const app = await phone();
  await app.waitUntil(() => attachmentRequests(app).length === 2);
  // A phone has no mouse to rest anywhere.
  let hovered = true;
  await app.hover(shotChip).catch(() => {
    hovered = false;
  });
  expect(hovered).toBe(false);
  await app.wait(600);
  expect(app.shows(shot)).toBe(false);
  await app.press(shotChip);
  await app.waitFor(bar("1 / 2 · shot.png · 2.0 KB"));
  await app.drag("id:picture-stage", { x: -160, y: 0 });
  await app.waitFor(bar("2 / 2 · photo.jpg · 3.0 KB"));
  await app.drag("id:picture-stage", { x: 160, y: 0 });
  await app.waitFor(bar("1 / 2 · shot.png · 2.0 KB"));
  // A swipe up or down is not a step.
  await app.drag("id:picture-stage", { x: 0, y: -160 });
  expect(app.shows(bar("1 / 2 · shot.png · 2.0 KB"))).toBe(true);
  await app.press("label:Close");
  await app.waitUntil(() => !app.shows("id:picture-stage"));
  // A run's picture opens on a tap as well.
  await app.press("label:Open image 1 of 2");
  await app.waitFor(bar("1 / 2 · PNG · 1 KB"));
});

test("a picture the host cannot give says so in the lightbox", async () => {
  const app = await open("./fixtures/pictures.tsx", {
    platform: "macos",
    width: 1024,
    height: 768,
    network: {
      [`GET http://example.invalid/attachments/${SHOT}`]: { status: 404 },
      [`GET http://example.invalid/attachments/${PHOTO}`]:
        picture("image/jpeg"),
    },
  });
  await app.press(shotChip);
  await app.waitFor("text:Couldn't load the image");
});
