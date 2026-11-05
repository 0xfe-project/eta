import { expect, open, test } from "nsh/test";

const start = (scenario = "") =>
  open("../../../DevApp.tsx", {
    storage: {
      "eta.host": JSON.stringify({ address: "fake", token: "" }),
      "eta.language": "zh",
      "eta.fake.scenario": scenario,
    },
  });

async function board(scenario = "") {
  const app = await start(scenario);
  await app.waitFor("id:tab-tasks");
  await app.press("id:tab-tasks");
  return app;
}

async function task(number: number, scenario = "") {
  const app = await board(scenario);
  await app.press(`id:task-${number}`);
  await app.waitFor("id:task-comment");
  return app;
}

test("05: the board reads as the design: sections, then folds", async () => {
  const app = await board();
  await app.waitFor("重连后补发丢失的帧");
  const texts = app.texts().join("|");
  expect(texts).toContain("待验收");
  expect(texts).toContain("#128 · 阿澈");
  expect(texts).toContain("#135 · 阿澈 · 还没运行过");
  expect(texts).toContain("正在运行");
  expect(texts).toContain("排队中");
  expect(app.shows("积压")).toBe(true);
  expect(app.shows("产物支持 PDF 预览")).toBe(false);
});

test("05a: an empty board says how tasks come to be", async () => {
  const app = await board("empty");
  await app.waitFor("还没有任务");
  expect(app.shows("所有群")).toBe(false);
});

test("05b: a fold opens, and its rest comes on asking", async () => {
  const app = await board();
  await app.press("id:fold-done");
  await app.waitFor("site 支持 SPA 回退");
  await app.waitFor("还有 25 条");
  await app.press("还有 25 条");
  await app.waitFor("已归档的第 25 件事");
  expect(app.shows("还有 25 条")).toBe(false);
});

test("05c: the board narrows to one group", async () => {
  const app = await board();
  await app.press("id:task-scope");
  await app.waitFor("看哪个群的任务");
  expect(app.shows("这个群还没有任务")).toBe(true);
  await app.press("id:scope-wire");
  await app.waitFor("id:task-128");
  expect(app.shows("id:task-131")).toBe(false);
  await app.press("id:task-scope");
  await app.press("id:scope-artifacts");
  await app.waitFor("这个群还没有任务");
});

test("06: a task reads as a thread, its description folded", async () => {
  const app = await task(128);
  expect(app.shows("重连后补发丢失的帧")).toBe(true);
  expect(app.shows("1 条回复")).toBe(true);
  expect(app.shows("6 条动态")).toBe(true);
  expect(app.shows("杀进程重连 200 次，没有丢帧。测试全过，等你验收。")).toBe(true);
  expect(app.shows("阿澈 把状态从「进行中」改为「待验收」")).toBe(true);
  await app.press("展开全文");
  await app.waitFor("收起");
  await app.press("6 条动态");
  await app.waitFor("阿澈 开始工作");
});

test("06: a comment comes back in the thread and wakes the executor", async () => {
  const app = await task(128);
  await app.type("id:task-comment", "再改一点");
  await app.press("id:task-send");
  await app.waitFor("发送中…");
  await app.waitFor("text:再改一点");
  await app.waitFor("阿澈 排队中 · mac-studio 同时运行的任务数已满，等空位");
  await app.waitFor("发送中…", { state: "gone" });
  expect(app.shows("2 条回复")).toBe(true);
});

test("06: @ offers the group's members and fills the name in", async () => {
  const app = await task(128);
  await app.press("id:task-at");
  await app.waitFor("Mori");
  await app.press("Mori");
  await app.type("id:task-comment", "看一下");
  await app.press("id:task-send");
  await app.waitFor("Mori 排队中 · mac-studio 同时运行的任务数已满，等空位");
});

test("06a: a blocked task asks over the thread and the reply goes to the box", async () => {
  const app = await task(129);
  expect(app.shows("阿澈 在等你回复")).toBe(true);
  expect(app.count("text:nas 从昨晚起连不上。要等它回来，还是先把归档存到 gpu-box？")).toBe(1);
  expect(app.shows("这一轮失败了：nas 连接超时")).toBe(true);
  expect(app.shows("2 条动态")).toBe(true);
  expect(app.shows("阿澈 排队中 · nas 不在线，连上后开始")).toBe(true);
  await app.press("id:task-reply");
  await app.waitFor("id:task-comment");
});

test("06b: what runs now sits over the box, and it stops", async () => {
  const app = await task(131);
  expect(app.shows("Mori 正在工作")).toBe(true);
  expect(app.count("text:停止")).toBe(2);
  await app.press("text:停止 >> nth=1");
  await app.waitFor("text:停止 >> nth=1", { state: "gone" });
});

test("06b: a comment that fails stays, to retry or discard", async () => {
  const app = await task(131, "comment-fails");
  await app.type("id:task-comment", "顺便把右栏宽度也记住。");
  await app.press("id:task-send");
  await app.waitFor("未送达：网络连接失败。");
  await app.press("重试");
  await app.waitFor("未送达：网络连接失败。", { state: "gone" });
  await app.waitFor("发送中…", { state: "gone" });
  expect(app.shows("1 条回复")).toBe(true);
});

test("06c: the properties, and rerunning from there", async () => {
  const app = await task(128);
  await app.press("id:task-properties");
  await app.waitFor("属性");
  expect(app.shows("~/.eta/worktrees/eta/task-128")).toBe(true);
  expect(app.shows("交付")).toBe(true);
  expect(app.shows("#472 重放缺失的帧")).toBe(true);
  await app.press("id:task-rerun");
  await app.waitFor("id:task-rerun", { state: "gone" });
  await app.waitFor("阿澈 排队中 · mac-studio 同时运行的任务数已满，等空位");
});

test("06c2: a run on another machine says where it really is", async () => {
  const app = await task(131);
  await app.press("id:task-properties");
  await app.waitFor("在 gpu-box 上，不在项目里");
  expect(app.shows("/home/akrc")).toBe(true);
  expect(app.shows("交付")).toBe(false);
  expect(app.shows("id:task-rerun")).toBe(false);
});

test("06d: the status moves, on the page and on the board", async () => {
  const app = await task(128);
  await app.press("id:task-status");
  await app.waitFor("id:status-done");
  await app.press("id:status-done");
  await app.waitFor("阿澈 把状态从「进行中」改为「待验收」");
  await app.waitFor("我 把状态从「待验收」改为「已完成」");
  await app.press("id:back");
  await app.waitFor("id:fold-done");
  expect(app.shows("id:task-128")).toBe(false);
});

test("06e: merging and completing are two steps done in order", async () => {
  const app = await task(128);
  await app.waitFor("id:pr-more");
  await app.press("id:pr-more");
  await app.waitFor("更多合并方式");
  await app.press("合并并标记任务完成");
  await app.waitFor("合并中…");
  await app.waitFor("PR 已合并，任务已完成", { timeout: 3000 });
  expect(app.shows("已完成")).toBe(true);
});

test("06e2: each state of a PR", async () => {
  const app = await task(128, "pr-states");
  await app.waitFor("检查还没过，GitHub 现在不让合并。");
  await app.waitFor("状态暂不可用");
  expect(app.count("text:标记任务完成")).toBe(2);
  await app.press("text:标记任务完成 >> nth=0");
  await app.waitFor("PR 已合并，任务未完成：宿主没有及时回应。");
});

test("06e2: a merge that gets no answer says so and reads the PR again", async () => {
  const app = await open("../../../DevApp.tsx", {
    clock: {},
    storage: {
      "eta.host": JSON.stringify({ address: "fake", token: "" }),
      "eta.language": "zh",
      "eta.fake.scenario": "pr-states",
    },
  });
  await app.waitFor("id:tab-tasks");
  await app.press("id:tab-tasks");
  await app.press("id:task-128");
  await app.waitFor("id:pr-merge");
  await app.press("id:pr-merge");
  await app.waitFor("合并中…");
  await app.waitFor("没有得到合并结果，已重新读取 PR 状态，请确认后再决定是否重试。", {
    timeout: 130_000,
  });
  expect(app.shows("id:pr-merge")).toBe(true);
});

test("no github: no PR bar, no 交付, no partial UI", async () => {
  const app = await task(128, "no-github");
  expect(app.shows("#472 重放缺失的帧")).toBe(false);
  await app.press("id:task-properties");
  await app.waitFor("属性");
  expect(app.shows("交付")).toBe(false);
});

test("06f: title and description save together", async () => {
  const app = await task(128);
  await app.press("id:task-more");
  await app.press("id:more-edit");
  await app.waitFor("支持 Markdown。");
  await app.type("id:task-title", "（修订）");
  await app.press("id:task-save");
  await app.waitFor("重连后补发丢失的帧（修订）");
  expect(app.shows("id:task-comment")).toBe(true);
});

test("06g: deleting asks, then the task is gone from the board", async () => {
  const app = await task(135);
  await app.press("id:task-more");
  await app.press("id:more-delete");
  await app.waitFor("删除任务 #135？");
  await app.press("role:button[删除]");
  await app.waitFor("id:task-128");
  expect(app.shows("id:task-135")).toBe(false);
});

test("06g: a task with a run going says why it stays", async () => {
  const app = await task(131);
  await app.press("id:task-more");
  await app.press("id:more-delete");
  await app.press("role:button[删除]");
  await app.waitFor("id:task-comment");
  await app.waitFor("没有成功：a run is working on this task; stop it before deleting");
});

test("06h: the runs of a task, each opening its log", async () => {
  const app = await task(129);
  await app.press("id:task-more");
  await app.press("id:more-runs");
  await app.waitFor("阿澈 · 运行失败");
  await app.press("阿澈 · 运行失败");
  await app.waitFor("#129 · 阿澈 · 执行记录");
  await app.press("id:back");
  await app.press("id:back");
  await app.waitFor("id:task-comment");
});

test("06h: a run's log is its session", async () => {
  const app = await task(128);
  await app.press("id:task-more");
  await app.press("id:more-runs");
  await app.waitFor("#128 · 阿澈 · 执行记录");
  await app.waitFor("工作区 ~/.eta/worktrees/eta/task-128");
  await app.waitFor("先看现在的重连路径，再决定补发从哪里接。");
});

test("06i: out of reach of the host, a task can be retried", async () => {
  const app = await board("drop");
  await app.waitFor("id:task-128");
  await app.waitFor("连接中断，正在重连…显示的状态可能不是最新的。");
  await app.press("id:task-128");
  await app.waitFor("无法加载任务");
  expect(app.shows("与宿主的连接已断开。")).toBe(true);
  expect(app.shows("重试")).toBe(true);
});

test("the dark theme draws the same task", async () => {
  const app = await open("../../../DevApp.tsx", {
    colorScheme: "dark",
    storage: {
      "eta.host": JSON.stringify({ address: "fake", token: "" }),
      "eta.language": "zh",
    },
  });
  await app.waitFor("id:tab-tasks");
  await app.press("id:tab-tasks");
  await app.press("id:task-128");
  await app.waitFor("id:pr-merge");
  expect(app.shows("#472 重放缺失的帧")).toBe(true);
});

test("a language change reaches the board", async () => {
  const app = await open("../../../DevApp.tsx", {
    storage: {
      "eta.host": JSON.stringify({ address: "fake", token: "" }),
      "eta.language": "en",
    },
  });
  await app.waitFor("id:tab-tasks");
  await app.press("id:tab-tasks");
  await app.waitFor("In review");
  await app.press("id:task-128");
  await app.waitFor("Reply; a running task reads it right away");
});

test("06i: a task the host no longer has", async () => {
  const app = await task135("task-gone");
  await app.waitFor("这个任务已不存在");
  expect(app.shows("它可能已被删除。")).toBe(true);
});

test("06i: a task on its way", async () => {
  const app = await task135("task-loading");
  await app.waitFor("id:back");
  expect(app.shows("id:task-comment")).toBe(false);
  expect(app.shows("这个任务已不存在")).toBe(false);
  expect(app.shows("无法加载任务")).toBe(false);
});

test("the link to a group moves the task between 05c's groups", async () => {
  const app = await task(135);
  await app.press("id:task-more");
  await app.press("id:more-link");
  await app.waitFor("关联到哪个群");
  await app.press("role:button[任务看板改版]");
  await app.waitFor("我 关联了群");
});

async function task135(scenario: string) {
  const app = await board(scenario);
  await app.press("id:task-135");
  return app;
}
