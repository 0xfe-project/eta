import { expect, open, test } from "nsh/test";

const SHOT = "6a0d3f0e-0000-4000-8000-000000000001";
const PHOTO = "6a0d3f0e-0000-4000-8000-000000000002";
const THIRD = "6a0d3f0e-0000-4000-8000-000000000005";
const OLD = "6a0d3f0e-0000-4000-8000-000000000004";
const picture = (type: string) => ({
  headers: { "content-type": type },
  body: "picture bytes",
});
const network = {
  [`GET http://example.invalid/attachments/${SHOT}`]: picture("image/png"),
  [`GET http://example.invalid/attachments/${PHOTO}`]: picture("image/jpeg"),
  [`GET http://example.invalid/attachments/${THIRD}`]: picture("image/png"),
  [`GET http://example.invalid/attachments/${OLD}`]: picture("image/png"),
};

const desktop = (
  options: { reducedMotion?: boolean; storage?: Record<string, string> } = {},
) =>
  open("./fixtures/picture-anchors.tsx", {
    platform: "macos",
    width: 1024,
    height: 768,
    network,
    clock: {},
    ...options,
  });
const phone = () =>
  open("./fixtures/picture-anchors.tsx", {
    platform: "ios",
    network,
    clock: {},
  });
type App = Awaited<ReturnType<typeof desktop>>;

const shotCard = "label:View picture shot.png · 2.0 KB";
const photoCard = "label:View picture photo.jpg · 3.0 KB";
const oldCard = "label:View picture old.png · 1.0 KB";
const blinking = "id:picture-caret-blinking";
const still = "id:picture-caret-still";
const viewer = "text:1 / 3 · shot.png · 2.0 KB";
const ring = "id:picture-card-ring";
const between = "text:￼Between them, a few words.";
const after = "text:￼And after the second.";
/** The carets drawn, blinking or still. */
const carets = (app: App) => app.count(blinking) + app.count(still);
const caretBox = (app: App) =>
  app.layout(app.count(blinking) ? blinking : still)!;
const rest = 120;
const linger = 1500;
const leave = 120;

async function hover(app: App, selector: string) {
  await app.hover(selector);
  await app.clock!.runFor(rest + 20);
}

test("at rest no caret is drawn", async () => {
  const app = await desktop();
  expect(carets(app)).toBe(0);
});

test("resting on a card grows a blinking hairline caret, a line tall, at its place between the characters, and no character moves", async () => {
  const app = await desktop();
  const before = app.layout(between)!;
  await app.hover(shotCard);
  await app.clock!.runFor(rest - 20);
  expect(carets(app)).toBe(0);
  await app.clock!.runFor(40);
  expect(app.count(blinking)).toBe(1);
  const at = caretBox(app);
  // A hairline a line of text tall, centred on the place: the start of "Between".
  expect([at.width, at.height]).toEqual([1, 22]);
  expect(Math.abs(at.x + at.width / 2 - before.x)).toBeLessThan(1);
  expect(Math.abs(at.y + at.height / 2 - (before.y + 11))).toBeLessThan(4);
  expect(app.layout(between)).toEqual(before);
  // The ring blinking with it lies on the card's outline.
  expect(app.layout(ring)).toEqual(app.layout(shotCard));
});

test("moving to another card moves the caret to that card's place: one caret, blinking", async () => {
  const app = await desktop();
  await hover(app, shotCard);
  const first = caretBox(app);
  await app.hover(photoCard);
  await app.clock!.runFor(20);
  expect(carets(app)).toBe(1);
  expect(app.count(blinking)).toBe(1);
  const at = caretBox(app);
  const last = app.layout(after)!;
  expect(at.y).toBeGreaterThan(first.y);
  expect(Math.abs(at.x + at.width / 2 - last.x)).toBeLessThan(1);
  expect(app.count(ring)).toBe(1);
  expect(app.layout(ring)).toEqual(app.layout(photoCard));
});

test("leaving waits out the grace, then the caret fades and goes", async () => {
  const app = await desktop();
  await hover(app, shotCard);
  await app.hover("label:Elsewhere");
  await app.clock!.runFor(rest - 60);
  expect(app.count(blinking)).toBe(1);
  await app.clock!.runFor(60 + leave + 20);
  expect(carets(app)).toBe(0);
  expect(app.count(ring)).toBe(0);
});

test("a place out of sight in the messages' box has no caret", async () => {
  const app = await desktop();
  await app.press("label:Look away");
  await hover(app, shotCard);
  expect(carets(app)).toBe(0);
});

test("a picture that stood nowhere shows no caret", async () => {
  const app = await desktop();
  await hover(app, oldCard);
  expect(carets(app)).toBe(0);
});

test("keyboard focus on a card counts as resting on it", async () => {
  const app = await desktop();
  await app.press("label:Elsewhere");
  // Tab walks over the other button, then each card, in turn.
  const drawn: number[] = [];
  for (let step = 0; step < 4; step++) {
    await app.keyboard.press("tab");
    await app.clock!.runFor(rest + leave + 100);
    drawn.push(carets(app));
  }
  expect(drawn).toEqual([0, 0, 1, 1]);
});

test("with reduced motion the caret is there at once and stays still, moves at once and goes at once", async () => {
  const app = await desktop({ reducedMotion: true });
  await hover(app, shotCard);
  expect(app.count(still)).toBe(1);
  expect(app.count(blinking)).toBe(0);
  const first = caretBox(app);
  await app.hover(photoCard);
  await app.clock!.runFor(20);
  expect(app.count(still)).toBe(1);
  expect(caretBox(app).y).toBeGreaterThan(first.y);
  await app.hover("label:Elsewhere");
  await app.clock!.runFor(rest + 20);
  expect(carets(app)).toBe(0);
});

test("turned off in Settings, resting on a card shows nothing", async () => {
  const app = await desktop({
    storage: { "eta.messages.picturePlaces": "off" },
  });
  await hover(app, shotCard);
  expect(carets(app)).toBe(0);
  expect(app.count(ring)).toBe(0);
});

test("on a touch screen, holding a card shows its caret without opening the picture; it stays a moment after the finger lifts", async () => {
  const app = await phone();
  await app.longPress(shotCard);
  expect(app.count(blinking)).toBe(1);
  expect(app.shows(viewer)).toBe(false);
  await app.clock!.runFor(linger / 2);
  expect(carets(app)).toBe(1);
  await app.clock!.runFor(linger / 2 + leave + 20);
  expect(carets(app)).toBe(0);
});

test("on a touch screen a tap opens the picture and shows no caret", async () => {
  const app = await phone();
  await app.press(shotCard);
  await app.waitFor(viewer);
  expect(carets(app)).toBe(0);
});
