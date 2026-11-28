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

const desktop = (reducedMotion = false, width = 1024) =>
  open("./fixtures/picture-anchors.tsx", {
    platform: "macos",
    width,
    height: 768,
    network,
    clock: {},
    reducedMotion,
  });
type App = Awaited<ReturnType<typeof desktop>>;

const shotCard = "label:View picture shot.png · 2.0 KB";
const photoCard = "label:View picture photo.jpg · 3.0 KB";
const thirdCard = "label:View picture third.png · 4.0 KB";
const oldCard = "label:View picture old.png · 1.0 KB";
const strokes = "id:picture-link-stroke";
const caret = "id:picture-link-caret";
const corners = "id:picture-link-corner";
/** The lines drawn: two strokes (along and rise) make one. */
const lines = (app: App) => app.count(strokes) / 2;
const rest = 120;
const stretch = 240;
const hop = 280;
const retract = 160;

async function hover(app: App, selector: string) {
  await app.hover(selector);
  await app.clock!.runFor(rest + stretch);
}

test("at rest the words hold no mark and nothing is drawn", async () => {
  const app = await desktop();
  expect(lines(app)).toBe(0);
  expect(app.count(caret)).toBe(0);
  expect(app.texts().join(" ")).not.toContain("Where");
});

test("resting on a card draws a line along its top edge and up a lane beside the words, to a caret at its place", async () => {
  const app = await desktop();
  await app.hover(shotCard);
  await app.clock!.runFor(rest - 20);
  expect(lines(app)).toBe(0);
  await app.clock!.runFor(20 + stretch);
  expect(lines(app)).toBe(1);
  expect(app.count(corners)).toBe(1);
  const card = app.layout(shotCard)!;
  const [along, rise] = [0, 1].map(
    (at) => app.layout(`${strokes} >> nth=${at}`)!,
  );
  // Along the card's top edge, from its corner nearest the lane.
  expect(along.height).toBe(1);
  expect(Math.round(along.y)).toBe(Math.round(card.y));
  expect(along.x).toBeGreaterThan(card.x);
  // The lane is 6 points past the words' right edge, and nothing is drawn over the words.
  const words = app.layout("text:￼Between them, a few words.")!;
  const edge = Math.max(
    ...[
      "text:￼Before the first.",
      "text:￼Between them, a few words.",
      "text:￼And after the second.",
    ].map((q) => {
      const box = app.layout(q)!;
      return box.x + box.width;
    }),
  );
  expect(Math.round(rise.x - edge)).toBe(6);
  expect(rise.width).toBe(1);
  // The caret is 2 by 16 on the lane, on the line of words the picture stood in, and the rise
  // ends at its bottom.
  const at = app.layout(caret)!;
  expect([at.width, at.height]).toEqual([2, 16]);
  expect(Math.abs(at.x + at.width / 2 - rise.x)).toBeLessThan(1);
  expect(at.y).toBeGreaterThanOrEqual(words.y - 4);
  expect(at.y + at.height).toBeLessThanOrEqual(words.y + words.height + 4);
  expect(Math.round(rise.y)).toBe(Math.round(at.y + at.height));
});

test("moving to the other card moves the same line: one line, never drawn back, ending at the other place", async () => {
  const app = await desktop();
  await hover(app, shotCard);
  const first = app.layout(caret)!;
  const laneBefore = app.layout(`${strokes} >> nth=1`)!.x;
  await app.hover(photoCard);
  // Half way, and at every step, there is one line and one caret, and the line has length.
  for (let step = 0; step < 6; step++) {
    await app.clock!.runFor(stretch / 6);
    expect(lines(app)).toBe(1);
    expect(app.count(caret)).toBe(1);
    expect(app.layout(`${strokes} >> nth=1`)!.height).toBeGreaterThan(0);
  }
  await app.clock!.runFor(50);
  const card = app.layout(photoCard)!;
  const at = app.layout(caret)!;
  // The second picture stood in the last paragraph: lower in the words.
  expect(at.y).toBeGreaterThan(first.y);
  const last = app.layout("text:￼And after the second.")!;
  expect(at.y).toBeGreaterThanOrEqual(last.y);
  expect(at.y + at.height).toBeLessThanOrEqual(last.y + last.height);
  // Only the length changes: the lane stays where it was, and so does the line's right end.
  const along = app.layout(`${strokes} >> nth=0`)!;
  const rise = app.layout(`${strokes} >> nth=1`)!;
  expect(rise.x).toBe(laneBefore);
  expect(Math.round(along.y)).toBe(Math.round(card.y));
});

test("moving to a card on another row stretches the same line down to it", async () => {
  const app = await desktop(false, 480);
  await hover(app, shotCard);
  const lane = app.layout(`${strokes} >> nth=1`)!;
  const before = app.layout(`${strokes} >> nth=0`)!;
  await app.hover(thirdCard);
  await app.clock!.runFor(hop + 50);
  expect(lines(app)).toBe(1);
  const along = app.layout(`${strokes} >> nth=0`)!;
  expect(app.layout(`${strokes} >> nth=1`)!.x).toBe(lane.x);
  // The third card is on the second row: its top edge is lower.
  expect(along.y).toBeGreaterThan(before.y);
  expect(Math.round(along.y)).toBe(Math.round(app.layout(thirdCard)!.y));
});

test("moving on again half way lands on the last card, not on one passed", async () => {
  const app = await desktop();
  await hover(app, shotCard);
  const first = app.layout(caret)!;
  await app.hover(photoCard);
  await app.clock!.runFor(stretch / 2);
  await app.hover(shotCard);
  await app.clock!.runFor(stretch + 50);
  expect(lines(app)).toBe(1);
  expect(app.layout(caret)!.y).toBe(first.y);
});

test("leaving waits out the grace, draws the line back into the card, then the caret goes", async () => {
  const app = await desktop();
  await hover(app, shotCard);
  await app.hover("label:Elsewhere");
  // Another card within the grace would take the line over: it stays as it is.
  await app.clock!.runFor(rest - 60);
  expect(lines(app)).toBe(1);
  expect(app.count(caret)).toBe(1);
  // Drawn back, it has no length left, and then the caret has gone too.
  await app.clock!.runFor(60 + retract / 2);
  expect(lines(app)).toBe(0);
  await app.clock!.runFor(retract);
  expect(app.count(caret)).toBe(0);
  // The other card has a line of its own, from nothing.
  await hover(app, photoCard);
  expect(lines(app)).toBe(1);
});

test("a place out of sight in the messages' box has no line", async () => {
  const app = await desktop();
  await app.press("label:Look away");
  await app.hover(shotCard);
  await app.clock!.runFor(rest + stretch + 100);
  expect(lines(app)).toBe(0);
  expect(app.shows(caret)).toBe(false);
});

test("a picture that stood nowhere draws no line", async () => {
  const app = await desktop();
  await app.hover(oldCard);
  await app.clock!.runFor(rest + stretch + 100);
  expect(lines(app)).toBe(0);
});

test("keyboard focus on a card counts as resting on it", async () => {
  const app = await desktop();
  await app.press("label:Elsewhere");
  // Tab walks over the other button, then each card, in turn.
  const drawn: number[] = [];
  for (let step = 0; step < 4; step++) {
    await app.keyboard.press("tab");
    await app.clock!.runFor(rest + stretch + retract + 100);
    drawn.push(lines(app));
  }
  expect(drawn).toEqual([0, 0, 1, 1]);
});

test("with reduced motion the line and the caret are there at once, move at once and go at once", async () => {
  const app = await desktop(true);
  await app.hover(shotCard);
  await app.clock!.runFor(rest + 20);
  expect(lines(app)).toBe(1);
  expect(app.count(caret)).toBe(1);
  const first = app.layout(caret)!;
  await app.hover(photoCard);
  await app.clock!.runFor(20);
  expect(app.layout(caret)!.y).toBeGreaterThan(first.y);
  await app.hover("label:Elsewhere");
  await app.clock!.runFor(rest + 20);
  expect(lines(app)).toBe(0);
});

test("on a touch screen nothing is drawn: a tap still opens the picture", async () => {
  const app = await open("./fixtures/picture-anchors.tsx", {
    platform: "ios",
    network,
    clock: {},
  });
  await app.press(shotCard);
  await app.waitFor("text:1 / 3 · shot.png · 2.0 KB");
  expect(lines(app)).toBe(0);
});
