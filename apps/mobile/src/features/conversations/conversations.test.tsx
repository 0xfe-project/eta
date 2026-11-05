import { expect, open, test } from "nsh/test";

const start = async (storage: Record<string, string> = {}) => {
  const app = await open("../../../DevApp.tsx", {
    storage: {
      "eta.host": JSON.stringify({ address: "fake", token: "" }),
      "eta.language": "zh",
      ...storage,
    },
  });
  await app.waitFor("id:tab-conversations");
  await app.press("id:tab-conversations");
  await app.waitFor(
    storage["eta.fake.scenario"] === "empty" ? "还没有对话。" : "wire 重连",
  );
  return app;
};

test("02: groups under their project, with what each is doing", async () => {
  const app = await start();
  const texts = app.texts();
  for (const text of [
    "eta",
    "mac-studio",
    "官网",
    "mb-air",
    "阿澈 等待确认",
    "Mori 工作中",
    "Mori 等待确认",
    "site 走 SPA 回退，版本里带上 manifest。",
    "昨天",
    "刚刚",
  ])
    expect(texts).toContain(text);
  expect(app.shows("label:群聊 2")).toBe(true);
  expect(app.shows("label:私聊 1")).toBe(true);
  expect(texts).not.toContain("发布流程");
});

test("02a: every agent has a row, and one nobody talked to gets its chat on the first press", async () => {
  const app = await start({ "eta.fake.scenario": "empty" });
  await app.press("label:私聊");
  expect(app.texts()).toContain("Mori");
  await app.press("id:direct-agent-mori");
  await app.waitUntil(() => app.count("id:tab-conversations") === 0);
  expect(app.texts()).not.toContain("等待确认");
});

test("02a: the private chats, a waiting one strong and the busy status over the preview", async () => {
  const app = await start();
  await app.press("label:私聊 1");
  for (const text of [
    "小满",
    "等待确认",
    "阿澈",
    "工作中",
    "Mori",
    "列宽的方案写好了，你看下。",
  ])
    expect(app.texts()).toContain(text);
  expect(app.texts()).not.toContain("周报发给谁？");
});

test("03p: a long press renames", async () => {
  const app = await start();
  await app.longPress("id:conversation-wire");
  for (const text of ["eta · mac-studio", "改名", "归档"])
    expect(app.texts()).toContain(text);
  await app.press("改名");
  await app.clear("id:rename-input");
  await app.type("id:rename-input", "重连收尾");
  await app.press("label:保存");
  await app.waitFor("重连收尾");
  expect(app.texts()).not.toContain("wire 重连");
});

test("03p, 03p2: archiving moves a row to 已归档, and back", async () => {
  const app = await start();
  await app.longPress("id:conversation-wire");
  await app.press("归档");
  await app.waitUntil(() => app.count("wire 重连") === 0);
  expect(app.shows("label:群聊 1")).toBe(true);
  await app.press("已归档");
  await app.waitFor("wire 重连");
  expect(app.texts()).toContain("eta · 10月2日");
  expect(app.texts()).toContain("官网 · 9月18日");
  await app.press("label:取消归档 wire 重连");
  await app.waitUntil(() => app.count("wire 重连") === 0);
  await app.press("id:back");
  await app.waitFor("wire 重连");
});

test("03p2: nothing archived says so", async () => {
  const app = await start();
  await app.press("已归档");
  await app.press("label:取消归档 发布流程");
  await app.waitUntil(() => app.count("发布流程") === 0);
  await app.press("label:取消归档 落地页文案");
  await app.waitFor("没有已归档的对话。");
});

test("a row opens its chat", async () => {
  const app = await start();
  await app.press("id:conversation-wire");
  await app.waitUntil(() => app.count("id:tab-conversations") === 0);
});
