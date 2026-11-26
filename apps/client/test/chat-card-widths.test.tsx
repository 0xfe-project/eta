import { expect, open, test } from "nsh/test";

const fixture = "./fixtures/chat-card-widths.tsx";
const taskCardLabel =
  "label:Task card #414 Align draft and confirmed task cards with chat content width";
const phoneTaskCardLabel =
  "label:Task #414 Align draft and confirmed task cards with chat content width";

function assertAligned(
  app: Awaited<ReturnType<typeof open>>,
  cardSelector: string,
  expectedColumnWidth?: number,
) {
  const column = app.layout("id:conversation-messages")!;
  const process = app.layout("label:Thinking process")!;
  const draftHead = app.layout("label:Task draft")!;
  const cardHead = app.layout(cardSelector)!;

  expect(column.width).toBeGreaterThan(0);
  if (expectedColumnWidth !== undefined)
    expect(column.width).toBe(expectedColumnWidth);

  // Both cards draw a 1px border around their head button; outer edges match
  // the reply column's blocks (Thinking process / reply prose) to the pixel.
  const draftLeft = draftHead.x - 1;
  const draftRight = draftHead.x + draftHead.width + 1;
  const cardLeft = cardHead.x - 1;
  const cardRight = cardHead.x + cardHead.width + 1;
  const processLeft = process.x;
  const processRight = process.x + process.width;

  expect(draftLeft).toBe(processLeft);
  expect(draftRight).toBe(processRight);
  expect(cardLeft).toBe(processLeft);
  expect(cardRight).toBe(processRight);
}

for (const [setting, expectedWidth] of [
  ["extra-narrow", 600],
  ["compact", 640],
  ["standard", 1040],
  ["wide", undefined],
] as const) {
  test(`draft and task cards align with reply edges under ${setting} chat width`, async () => {
    const app = await open(fixture, {
      width: 1920,
      height: 1000,
      locale: "en-US",
      urlScheme: `eta://fixture?width=${setting}&theme=light`,
    });
    await app.waitFor("label:Task draft");
    assertAligned(app, taskCardLabel, expectedWidth);
    if (setting === "wide") {
      expect(app.layout("id:conversation-messages")!.width).toBeGreaterThan(
        1040,
      );
    }
    if (setting === "standard") {
      await app.press("label:Collapse sidebar");
      await app.waitUntil(
        () => app.layout("id:conversation-messages")?.width === 720,
      );
      assertAligned(app, taskCardLabel, 720);
    }
    app.dispose();
  });
}

test("draft and task cards stay aligned when chat width changes in Settings", async () => {
  const app = await open(fixture, {
    width: 1920,
    height: 1000,
    locale: "en-US",
    urlScheme: "eta://fixture?width=standard&theme=light",
  });
  await app.waitFor("label:Task draft");
  assertAligned(app, taskCardLabel, 1040);

  for (const [choice, expectedWidth] of [
    ["Full", undefined],
    ["Extra narrow", 600],
    ["Narrow", 640],
    ["Standard", 1040],
  ] as const) {
    await app.press("label:Settings");
    await app.waitFor("text:Appearance");
    await app.press("text:Appearance");
    await app.waitFor("label:Chat content width");
    await app.press("label:Chat content width");
    await app.waitFor(`label:${choice}`);
    await app.press(`label:${choice}`);
    await app.press("label:Close");
    await app.waitFor("label:Task draft");
    assertAligned(app, taskCardLabel, expectedWidth);
  }
  app.dispose();
});

test("phone keeps draft and task cards full column width", async () => {
  const app = await open(fixture, {
    width: 390,
    height: 844,
    locale: "en-US",
    urlScheme: "eta://fixture?width=standard&theme=light",
  });
  await app.waitFor("text:eta");
  await app.press("text:eta");
  await app.waitFor("label:Task draft");
  assertAligned(app, phoneTaskCardLabel, 390);
  app.dispose();
});
