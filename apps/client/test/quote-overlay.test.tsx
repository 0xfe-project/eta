import type { MessageView } from "@eta/client-contracts";
import type { ViewRef } from "nsh";
import { expect, open, test } from "nsh/test";
import { createQuoteSelection } from "../src/pages/chat/quote-selection";

const fixture = "./fixtures/quote-overlay.tsx";

const message = (id = "m1", conversationId = "c1"): MessageView => ({
  id,
  conversationId,
  seq: 1,
  kind: "message",
  author: "agent",
  agentId: "Ada",
  text: "Selected phrase",
  thinking: "",
  status: "done",
  revision: 1,
  mentions: [],
  rootMessageId: null,
  replyToId: null,
  data: {},
  createdAt: 0,
  updatedAt: 0,
});

const bounds = {
  origin: { x: 20, y: 40 },
  size: { width: 120, height: 24 },
};

const selectionEvent = (text: string) => ({
  text,
  start: 0,
  pageBounds: text ? bounds : undefined,
  read: () => text,
});

const dummyRef = {} as ViewRef;

test("controller keeps Quote mounted when empty selection arrives during a >=100ms press hold and fires onQuote on release", async () => {
  const quoted: Array<{ conversationId: string; text: string }> = [];
  const controller = createQuoteSelection({
    phone: () => false,
    onQuote: (conversationId, text) => quoted.push({ conversationId, text }),
  });
  const reply = message();

  controller.select(reply, selectionEvent("Selected phrase"), dummyRef);
  expect(controller.current()?.message.id).toBe("m1");

  // Pointer presses down on Quote overlay (capture + pressDown may both call pressStart).
  controller.pressStart();
  // Async empty selectionchange arrives while button is held down.
  controller.select(reply, selectionEvent(""), dummyRef);
  // Idempotent second pressStart from onPressDown must not forget clearedDuringPress.
  controller.pressStart();
  expect(controller.current()?.message.id).toBe("m1");

  await new Promise((resolve) => setTimeout(resolve, 120));
  expect(controller.current()?.message.id).toBe("m1");

  controller.pressEnd();
  controller.quote();
  expect(quoted).toEqual([{ conversationId: "c1", text: "Selected phrase" }]);
  expect(controller.current()).toBeUndefined();
});

test("controller dismisses orphaned Quote button after an aborted press when selection cleared during hold", async () => {
  const quoted: string[] = [];
  const controller = createQuoteSelection({
    phone: () => false,
    onQuote: (_conversationId, text) => quoted.push(text),
  });
  const reply = message();

  controller.select(reply, selectionEvent("Selected phrase"), dummyRef);
  controller.pressStart();
  controller.select(reply, selectionEvent(""), dummyRef);
  await new Promise((resolve) => setTimeout(resolve, 110));
  expect(controller.current()).toBeDefined();

  // Released / dragged off / cancelled without quote() firing.
  controller.pressEnd();
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(controller.current()).toBeUndefined();
  expect(quoted).toEqual([]);
});

test("controller clears immediately on scroll, click outside, and ignores unrelated empty selections", () => {
  const controller = createQuoteSelection({
    phone: () => false,
    onQuote: () => {},
  });
  const reply = message("m1");
  const other = message("m2");

  controller.select(reply, selectionEvent("Selected phrase"), dummyRef);
  controller.select(other, selectionEvent(""), dummyRef);
  expect(controller.current()?.message.id).toBe("m1");

  // Scroll while pressing cancels press state and clears selection.
  controller.pressStart();
  controller.select(reply, selectionEvent(""), dummyRef);
  controller.dismiss();
  expect(controller.current()).toBeUndefined();

  // Click outside (no pressStart on Quote): empty selection clears immediately.
  controller.select(reply, selectionEvent("Selected phrase"), dummyRef);
  controller.select(reply, selectionEvent(""), dummyRef);
  expect(controller.current()).toBeUndefined();
});

test("controller suppresses Quote overlay on phones", () => {
  const controller = createQuoteSelection({
    phone: () => true,
    onQuote: () => {},
  });
  controller.select(message(), selectionEvent("Selected phrase"), dummyRef);
  expect(controller.current()).toBeUndefined();
});

test("UI: Quote overlay stays alive through >=100ms hold when pointer-down clears selection and quotes on release", async () => {
  const app = await open(fixture, {
    platform: "macos",
    width: 900,
    height: 700,
    locale: "en-US",
  });

  await app.press("label:Select reply");
  await app.waitFor("label:Quote");

  // 120ms hold while the async 10ms selection-clear fires mid-hold: Quote remains mounted.
  await app.dragAndHold("label:Quote", { x: 0, y: 0 }, { hold: 120 });
  await app.wait(20);
  expect(app.shows("label:Quote")).toBe(true);
  await app.drop();
  await app.waitFor("text:quoted:Quoted reply line");
  expect(app.shows("text:count:1")).toBe(true);
  await app.waitUntil(() => !app.shows("label:Quote"));
});

test("UI: dragging off Quote dismisses the orphaned button without quoting", async () => {
  const app = await open(fixture, {
    platform: "macos",
    width: 900,
    height: 700,
    locale: "en-US",
  });

  await app.press("label:Select reply");
  await app.waitFor("label:Quote");
  await app.drag("label:Quote", { x: 180, y: 0 }, { hold: 120 });
  await app.waitUntil(() => !app.shows("label:Quote"));
  expect(app.shows("text:count:0")).toBe(true);
});

test("UI: scrolling the list and clicking outside dismiss the Quote overlay", async () => {
  const app = await open(fixture, {
    platform: "macos",
    width: 900,
    height: 700,
    locale: "en-US",
  });

  // Scroll dismisses Quote.
  await app.press("label:Select reply");
  await app.waitFor("label:Quote");
  await app.scroll("id:timeline-list", 120);
  await app.waitUntil(() => !app.shows("label:Quote"));

  // Click outside triggers async empty selection without pressStart, dismissing immediately.
  await app.press("label:Select reply");
  await app.waitFor("label:Quote");
  await app.press("id:outside-area");
  await app.waitUntil(() => !app.shows("label:Quote"));
  expect(app.shows("text:count:0")).toBe(true);
});
