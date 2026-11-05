import { expect, open, test } from "nsh/test";

const HOST = JSON.stringify({ address: "mac-studio.tail3f2a.ts.net", token: "secret" });
const start = (scenario = "", extra: Record<string, string> = {}) =>
  open("../../../DevApp.tsx", {
    storage: {
      "eta.host": HOST,
      "eta.language": "zh",
      "eta.fake.scenario": scenario,
      ...extra,
    },
  });

test("01: gauges, questions oldest first, tasks", async () => {
  const app = await start();
  await app.waitFor("确认请求 3");
  const texts = app.texts();
  expect(texts).toContain("ETA");
  expect(texts).toContain("3 台机器在线");
  expect(texts).toContain("6");
  expect(texts).toContain("等你");
  expect(texts).toContain("任务 3");
  expect(texts).toContain("重连后补发丢失的帧");
  expect(texts).toContain("#128 · 待验收 · 阿澈");
  expect(texts).toContain("#129 · 受阻 · 阿澈在等你回复");
  expect(texts).toContain("私聊");
  expect(texts.indexOf("迁移脚本要直接在生产库上跑吗？")).toBeLessThan(
    texts.indexOf("周报发给谁？"),
  );
});

test("an approval shows its command, and allow answers in place", async () => {
  const app = await start();
  await app.waitFor("想把分支推到远端");
  expect(app.texts()).toContain("git push origin redesign --force-with-lease");
  await app.press("允许");
  await app.waitFor("确认请求 2");
  expect(app.texts()).not.toContain("想把分支推到远端");
  expect(app.texts()).toContain("5");
});

test("an option answers in place and the question goes", async () => {
  const app = await start();
  await app.waitFor("先备份再跑");
  await app.press("先备份再跑");
  await app.waitFor("确认请求 2");
  expect(app.texts()).not.toContain("迁移脚本要直接在生产库上跑吗？");
});

test("a freeform answer needs words, and goes with 发送", async () => {
  const app = await start();
  await app.waitFor("周报发给谁？");
  await app.press("发送");
  await app.wait(50);
  expect(app.texts()).toContain("周报发给谁？");
  await app.type("label:回答", "发给全员");
  await app.press("发送");
  await app.waitFor("确认请求 2");
  expect(app.texts()).not.toContain("周报发给谁？");
});

test("typing survives another question being answered", async () => {
  const app = await start();
  await app.waitFor("周报发给谁？");
  await app.type("label:回答", "全员");
  await app.press("先备份再跑");
  await app.waitFor("确认请求 2");
  expect(app.value("label:回答")).toBe("全员");
});

test("放弃 settles it with nothing", async () => {
  const app = await start();
  await app.waitFor("id:give-up-q-push");
  await app.press("id:give-up-q-push");
  await app.waitFor("确认请求 2");
  expect(app.texts()).not.toContain("想把分支推到远端");
});

test("01b: pick several, send them in the options' order", async () => {
  const app = await start("multi");
  await app.waitFor("这次发布要包含哪些改动？可以多选。");
  expect(app.texts()).toContain("放弃会结束正在等这个答复的那次运行。");
  await app.press("迁移脚本");
  await app.press("重连补帧");
  await app.waitFor("发送 2 项");
  await app.press("迁移脚本");
  await app.waitFor("发送 1 项");
  await app.press("迁移脚本");
  await app.press("发送 2 项");
  await app.waitFor("没有等你处理的事");
});

test("more answers than a row holds still answer, and can be given up", async () => {
  const app = await start("many");
  await app.waitFor("什么时候跑迁移？");
  expect(app.texts()).toContain("下周");
  expect(app.count("id:give-up-q-window")).toBe(1);
  await app.press("下周");
  await app.waitFor("没有等你处理的事");
});

test("01a: nothing waits, and the page says what runs", async () => {
  const app = await start("answered");
  await app.waitFor("没有等你处理的事");
  await app.waitFor("在跑 4");
  await app.waitFor("改 task-board.tsx · 8 分钟");
  await app.waitFor("运行 bun test wire · 2 分钟");
  await app.waitFor("gpu-box · 读 hero.tsx · 30 秒");
  await app.waitFor("思考中 · 1 分钟");
  expect(app.texts()).toContain("Mori · 任务看板改版");
  expect(app.texts()).toContain("小满 · #133 运行记录支持分页");
});

test("a row opens the conversation or task it is about", async () => {
  const app = await start();
  await app.waitFor("重连后补发丢失的帧");
  await app.press("重连后补发丢失的帧");
  await app.waitFor("id:back");
  await app.press("id:back");
  await app.waitFor("id:machines-online");
  await app.press("id:machines-online");
  await app.waitFor("mac-studio");
});

test("08b: while reconnecting a question can't be answered, then it can", async () => {
  const app = await start("blip");
  await app.waitFor("先备份再跑");
  await app.waitFor("连接中断，正在重连…显示的状态可能不是最新的。");
  expect(app.count("id:give-up-q-migrate")).toBe(0);
  await app.press("先备份再跑");
  await app.wait(50);
  expect(app.texts()).toContain("迁移脚本要直接在生产库上跑吗？");
  await app.waitFor("id:give-up-q-migrate", { timeout: 15_000 });
  await app.press("先备份再跑");
  await app.waitFor("确认请求 2");
});
