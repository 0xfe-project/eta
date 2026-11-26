import { expect, open, test } from "nsh/test";

// Ache and Mori both answer wire-9 (`chat-insert`); wire-5 and wire-7 are user messages nobody is
// answering. `chat-insert-ends` ends both turns a few seconds after the group is opened.
async function group(scenario: string) {
  const app = await open("../../../DevApp.tsx", {
    storage: {
      "eta.host": JSON.stringify({ address: "fake", token: "" }),
      "eta.language": "zh",
      "eta.fake.scenario": scenario,
    },
  });
  await app.waitFor("id:tab-conversations");
  await app.press("id:tab-conversations");
  // Opened by the fixture's own title.
  await app.waitFor("text:wire reconnect");
  await app.press("text:wire reconnect");
  await app.waitFor("id:composer-input");
  return app;
}

const ASKED =
  "@Ache @Mori Check the reconnect path and the migration together.";
const STEER = "— 收到你插入的消息 —";
const count = (texts: string[], text: string) =>
  texts.filter((one) => one === text).length;

test("insert: only on the message whose turn is still writing", async () => {
  const app = await group("chat-insert");
  await app.waitFor(`text:${ASKED}`);
  await app.waitFor("id:insert-wire-9");
  expect(app.shows("id:insert-wire-7")).toBe(false);
  expect(app.shows("id:insert-wire-5")).toBe(false);
  // Both turns stopped: nothing left to put words into.
  await app.press("id:process-stop >> nth=0");
  await app.press("id:process-stop >> nth=1");
  await app.waitFor("id:insert-wire-9", { state: "gone" });
});

test("insert: the sheet names who it reaches, keeps its draft, and the words fold into the message", async () => {
  const app = await group("chat-insert");
  await app.press("id:insert-wire-9");
  await app.waitFor("id:insert-sheet");
  expect(app.texts()).toContain("插给 Ache、Mori");
  await app.type("id:insert-input", "Also check the rollback.");
  // Closed and opened again: the words are still there.
  await app.press("role:button[取消]");
  await app.waitFor("id:insert-sheet", { state: "gone" });
  await app.press("id:insert-wire-9");
  await app.waitUntil(
    () => app.value("id:insert-input") === "Also check the rollback.",
  );
  await app.press("id:insert-send");
  await app.waitFor("id:insert-sheet", { state: "gone" });
  // Drawn once, inside the bubble it went into, under its mark; never as a row of its own.
  await app.waitFor("text:/^插入 · \\d+:\\d\\d$/");
  expect(count(app.texts(), "Also check the rollback.")).toBe(1);
  expect(app.shows("text:/^已并入/")).toBe(false);
  // Each process box marks where the words arrived, without repeating them.
  await app.waitUntil(() => count(app.texts(), STEER) === 2);
  // The turns are still writing: a second insert stacks under the first.
  await app.press("id:insert-wire-9");
  await app.type("id:insert-input", "And the docs.");
  await app.press("id:insert-send");
  await app.waitUntil(
    () =>
      app.texts().filter((text) => /^插入 · \d+:\d\d$/.test(text)).length === 2,
  );
  expect(count(app.texts(), "And the docs.")).toBe(1);
});

test("insert: after the turn ended it goes out as a new message, and says so", async () => {
  const app = await group("chat-insert-ends");
  await app.waitFor("id:insert-wire-9");
  await app.press("id:insert-wire-9");
  await app.type("id:insert-input", "One more thing.");
  // Both turns end while the sheet is open.
  await app.waitUntil(() => !app.shows("id:process-stop"), { timeout: 15_000 });
  expect(app.texts()).toContain("插给 Ache、Mori");
  await app.press("id:insert-send");
  await app.waitFor("text:这一轮已经结束，已作为新消息发出");
  // A new message, at the live end (go back there if the list was left above it).
  if (app.shows("text:/^新活动/")) await app.press("text:/^新活动/");
  await app.waitFor("text:One more thing.", { timeout: 10_000 });
  expect(app.shows("text:/^插入 · /")).toBe(false);
});

test("stop: each writing reply has its own, and it stops only that reply", async () => {
  const app = await group("chat-insert");
  await app.waitFor("id:process-stop >> nth=1");
  await app.press("id:process-stop >> nth=0");
  await app.waitFor("role:button[停止中…]");
  // The other reply still writes, with its own Stop.
  expect(app.shows("role:button[停止]")).toBe(true);
  // Pressing again while it stops asks again, harmlessly.
  await app.press("role:button[停止中…]");
  await app.waitFor("text:已停止");
  expect(count(app.texts(), "已停止")).toBe(1);
  expect(app.shows("role:button[停止]")).toBe(true);
});

test("composer: the button is always Send, and an empty box stops nothing", async () => {
  const app = await group("chat-insert");
  await app.waitFor("id:process-stop >> nth=1");
  expect(app.shows("role:button[发送]")).toBe(true);
  await app.press("id:composer-submit");
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(app.shows("text:停止中…")).toBe(false);
  expect(app.shows("text:已停止")).toBe(false);
});

test("composer: / is a plain character, with no menu", async () => {
  const app = await group("chat-insert");
  await app.type("id:composer-input", "/");
  expect(app.shows("id:composer-menu")).toBe(false);
  await app.type("id:composer-input", "compact");
  expect(app.shows("id:composer-menu")).toBe(false);
  expect(app.shows("id:composer-submit")).toBe(true);
});

test("composer: a message to a member who is answering is held until its turn ends", async () => {
  const app = await group("chat-insert");
  await app.waitFor("id:insert-wire-9");
  await app.type("id:composer-input", "Next: the docs.");
  await app.press("id:composer-submit");
  await app.waitFor("text:/这一轮结束后发出/");
  expect(app.texts()).toContain("Next: the docs.");
  expect(app.shows("text:插入这一轮")).toBe(false);
  expect(app.shows("text:拉回")).toBe(true);
  expect(app.shows("text:删除")).toBe(true);
});
