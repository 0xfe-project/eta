import { expect, open, test } from "nsh/test";
import { motion } from "../src/components/motion";

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
      // A skeleton is drawn only once its wait has lasted `motion.reveal`.
      if (scenario === "loading") await app.wait(motion.reveal + 50);
      expect(app.shows(`${messages} >> ${content}`)).toBe(true);
      expect(app.shows(composer)).toBe(true);
      expect(app.shows(`${messages} >> ${composer}`)).toBe(false);
      expect(app.shows(`${messages} >> ${skeleton}`)).toBe(
        scenario === "loading",
      );
    });

test("the chat rail offers a jump for both the prompt and the agent reply", async () => {
  const app = await open(fixture, {
    width: 1440,
    height: 900,
    urlScheme: "eta://fixture/short",
  });
  await app.press("label:Reply 1");
  await app.press("label:Prompt 1");
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
  expect(app.shows(`${messages} >> text:Can't reach the host`)).toBe(true);
  expect(app.shows(skeleton)).toBe(false);
  expect(app.shows(composer)).toBe(true);
  expect(app.shows(`${messages} >> ${composer}`)).toBe(false);
});

for (const [name, width, height] of sizes)
  test(`a queued message waits above the composer, not in the transcript, until a lane takes it (${name})`, async () => {
    const app = await open(fixture, {
      width,
      height,
      locale: "en-US",
      urlScheme: "eta://fixture/held",
    });
    // Above the box, not in the conversation: neither the words nor the
    // empty reply the host queued for them, and no legacy steer-from-queue button.
    expect(app.shows(`${composer} >> label:Queued message: Queued words`)).toBe(
      true,
    );
    expect(app.shows(`${composer} >> text:Insert into this turn`)).toBe(false);
    expect(app.shows(`${messages} >> text:Queued words`)).toBe(false);
    expect(app.shows(`${messages} >> text:Queued`)).toBe(false);
    await app.press("label:Deliver");
    await app.waitFor(`${messages} >> text:Queued words`);
    expect(app.shows("label:Queued message: Queued words")).toBe(false);
  });

for (const [name, width, height] of sizes)
  test(`inserted via the inline popover, a message renders under the target message before the reply (${name})`, async () => {
    const app = await open(fixture, {
      width,
      height,
      locale: "en-US",
      urlScheme: "eta://fixture/held",
    });
    await app.press("role:button[Insert message]");
    await app.waitFor("id:insert-popover");
    await app.type("id:insert-popover >> id:eta-editor", "Clarify scope");
    await app.press("id:insert-popover >> label:Insert");
    await app.waitFor(`${messages} >> text:Clarify scope`);
    expect(app.shows('text:{"into":"m1","mode":"steer"}')).toBe(true);
    expect(app.count(`${messages} >> text:Clarify scope`)).toBe(1);
    const texts = app.texts();
    const inserted = texts.findIndex((text) =>
      /^inserted · /i.test(text.replace(/^· /, "")),
    );
    expect(inserted).toBeGreaterThan(texts.indexOf("ping"));
    expect(texts.indexOf("Clarify scope")).toBe(inserted + 1);
  });

for (const [name, width, height] of [
  ["desktop", 1440, 900],
  ["phone", 390, 844],
] as const)
  test(`Captain review card offers inline Insert and renders Inserted below the card before Captain's reply (${name})`, async () => {
    const app = await open(fixture, {
      width,
      height,
      locale: "en-US",
      urlScheme: "eta://fixture/captain-review",
    });
    await app.waitFor(`${messages} >> text:Task #7 stalled`);
    expect(app.shows(`${messages} >> role:button[Insert message]`)).toBe(true);
    await app.press(`${messages} >> role:button[Insert message]`);
    await app.waitFor("id:insert-popover");
    await app.type("id:insert-popover >> id:eta-editor", "Focus on #7 first");
    await app.press("id:insert-popover >> label:Insert");
    await app.waitFor(`${messages} >> text:Focus on #7 first`);
    expect(app.shows('text:{"into":"r1","mode":"steer"}')).toBe(true);
    expect(app.count(`${messages} >> text:Focus on #7 first`)).toBe(1);
    const texts = app.texts();
    const inserted = texts.findIndex((text) =>
      /^inserted · /i.test(text.replace(/^· /, "")),
    );
    expect(inserted).toBeGreaterThan(texts.indexOf("Task #7 stalled"));
    expect(texts.indexOf("Focus on #7 first")).toBe(inserted + 1);
    expect(texts.indexOf("Working…")).toBeGreaterThan(
      texts.indexOf("Focus on #7 first"),
    );
  });

test("the desktop panel remembers both positions and never marks its button with pending work", async () => {
  const options = {
    width: 1440,
    height: 900,
    locale: "en-US",
    urlScheme: "eta://fixture/pending",
  };
  const app = await open(fixture, options);
  expect(app.shows("label:Resize panel")).toBe(true);
  expect(app.shows("id:panel-attention")).toBe(false);
  await app.press("label:Hide panel");
  expect(app.shows("label:Context")).toBe(false);
  expect(app.shows("label:Resize panel")).toBe(false);
  expect(app.shows("id:panel-attention")).toBe(false);
  const folded = app.storage();
  app.dispose();

  const again = await open(fixture, { ...options, storage: folded });
  await again.waitUntil(() => !again.shows("label:Resize panel"));
  await again.press("label:Show panel");
  expect(again.shows("label:Context")).toBe(true);
  const expanded = again.storage();
  expect(expanded["eta.panel.open"]).toBe("true");
  again.dispose();
  const last = await open(fixture, {
    ...options,
    urlScheme: "eta://fixture/short",
    storage: expanded,
  });
  expect(last.shows("label:Resize panel")).toBe(true);
  expect(last.shows("id:panel-attention")).toBe(false);
});

test("the tablet panel button still marks pending work, since its panel is in a drawer", async () => {
  const app = await open(fixture, {
    width: 834,
    height: 1112,
    locale: "en-US",
    urlScheme: "eta://fixture/pending",
  });
  expect(app.shows("label:Panel")).toBe(true);
  expect(app.shows("id:panel-attention")).toBe(true);
});

for (const [width, button] of [
  [834, "Panel"],
  [390, "Conversation info"],
] as const)
  test(`the ${width}px chat keeps its own panel entry`, async () => {
    const app = await open(fixture, {
      width,
      height: 900,
      locale: "en-US",
      storage: { "eta.panel.open": "false" },
    });
    await app.press(`label:${button}`);
    expect(app.shows(width === 834 ? "label:Context" : "label:Close")).toBe(
      true,
    );
    expect(app.shows("label:Resize panel")).toBe(false);
    expect(app.storage()["eta.panel.open"]).toBe("false");
  });
