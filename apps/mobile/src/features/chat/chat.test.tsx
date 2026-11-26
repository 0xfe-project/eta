import { expect, open, test } from "nsh/test";

const HOST = JSON.stringify({ address: "fake", token: "" });

const NAMES: Record<string, string> = {
  // The fixture names it in English now; either spelling opens it.
  wire: "/^wire (重连|reconnect)$/",
  board: "任务看板改版",
  artifacts: "产物版本",
  "dm-xiaoman": "/^(小满|Xiaoman)$/",
};

async function chat(id: string, scenario = "", language = "zh") {
  const app = await open("../../../DevApp.tsx", {
    storage: {
      "eta.host": HOST,
      "eta.language": language,
      ...(scenario === "" ? {} : { "eta.fake.scenario": scenario }),
    },
  });
  await app.waitFor("id:tab-conversations");
  await app.press("id:tab-conversations");
  if (scenario === "chat-archived") {
    await app.waitFor("text:已归档");
    await app.press("text:已归档");
  }
  if (id === "dm-xiaoman") {
    await app.waitFor("text:/^私聊/");
    await app.press("text:/^私聊/");
  }
  await app.waitFor(`text:${NAMES[id]}`);
  await app.press(`text:${NAMES[id]}`);
  await app.waitFor("id:composer-input");
  return app;
}

test("03: a group's run in its box, who waits near the composer, the question over it", async () => {
  const app = await chat("wire");
  await app.waitFor("text:重连后先补发，再恢复实时帧。迁移也一起带上。");
  await app.waitFor("text:14 步");
  expect(app.texts()).toContain("eta · 主理人：阿澈");
  expect(app.texts()).toContain("写了 migrations/0042_seq.sql +20");
  expect(app.texts()).toContain("运行 bun test wire 51 pass");
  expect(app.texts()).toContain("迁移会锁 message 表大约 40 秒，得你定。");
  expect(app.texts()).toContain("Mori 排队中，等阿澈说完");
  expect(app.value("id:composer-input")).toBe("");
  expect(app.shows("text:发消息给 阿澈…")).toBe(true);
  expect(app.shows("role:button[停止]")).toBe(true);
});

test("03: a finished reply keeps what it said between its calls", async () => {
  const app = await chat("wire", "chat-process");
  // Folded to its head, which says how many steps and nothing more; every sentence is on 04.
  await app.waitFor("text:3 步");
  expect(app.texts()).not.toContain("wire.ts never resends after a reconnect.");
  await app.press("role:button[查看全部] >> nth=0");
  await app.waitFor("text:wire.ts never resends after a reconnect.");
});

test("03: a reply at work writes everything in its box, and its answer comes under it once the run ends", async () => {
  const app = await chat("wire", "chat-said");
  await app.waitFor("text:3 步");
  // Its words are in the box, in order, with its calls: nothing is drawn outside it yet.
  expect(app.shows("id:process-frame")).toBe(true);
  expect(app.texts()).toContain("Now the replay path.");
  // What it says is a step headed 说明, open as it streams.
  expect(app.shows("role:button[说明]")).toBe(true);
  // The answer is written in the box too, as it streams, and the box stays open after it.
  await app.waitFor("text:The host replays from the last seq the client saw.", {
    timeout: 10_000,
  });
  expect(app.shows("id:process-frame")).toBe(true);
  // The run ends: the box folds to its head, the answer under it.
  await app.waitUntil(() => !app.shows("id:process-frame"), {
    timeout: 10_000,
  });
  expect(app.texts()).toContain("3 步");
  expect(app.texts()).toContain(
    "The host replays from the last seq the client saw.",
  );
  expect(app.texts()).not.toContain("Now the replay path.");
});

test("04: what a reply said on its way is among its steps", async () => {
  const app = await chat("wire", "chat-said");
  await app.waitFor("text:3 步");
  await app.press("role:button[查看全部] >> nth=1");
  await app.waitFor("text:Ache 的过程");
  await app.waitFor(
    "text:I'll read wire.ts first, then the replay path on the host.",
  );
  expect(app.texts()).toContain("Now the replay path.");
  expect(app.texts()).toContain("src/server/replay.ts");
});

test("04: what a reply said is a 说明 step, open until its head folds it", async () => {
  const app = await chat("wire", "chat-said");
  await app.waitFor("text:3 步");
  await app.press("role:button[查看全部] >> nth=1");
  await app.waitFor("text:Ache 的过程");
  const said = [
    "I'll read wire.ts first, then the replay path on the host.",
    "Now the replay path.",
  ];
  await app.waitFor(`text:${said[0]}`);
  expect(said.every((line) => app.texts().includes(line))).toBe(true);
  await app.press("role:button[说明] >> nth=0");
  await app.waitUntil(
    () => said.filter((line) => app.texts().includes(line)).length === 1,
  );
});

test("03: stop is in the running reply's box, and goes to that reply", async () => {
  const app = await chat("wire");
  await app.waitFor("text:14 步");
  await app.press("id:process-stop");
  await app.waitFor("text:停止中…");
  await app.waitFor("text:已停止");
});

test("04: the whole process in human words", async () => {
  const app = await chat("wire");
  await app.waitFor("text:14 步");
  await app.press("role:button[查看全部] >> nth=1");
  await app.waitFor("text:阿澈 的过程");
  expect(app.texts()).toContain("14 步 · 6 分钟");
  expect(app.texts()).toContain("思考过程 · 1,240 字");
  expect(app.texts()).toContain("前面 3 步");
  expect(app.texts()).toContain("“last_seq” · 18 处");
  expect(app.texts()).toContain("被拦");
  expect(app.texts()).toContain("rm -rf ~/.eta/cache");
  expect(app.texts()).toContain("全过");
  expect(app.texts()).toContain("迁移脚本要直接在生产库上跑吗？");
  await app.press("text:前面 3 步");
  await app.waitFor("text:package.json");
});

test("03i: an edit's diff folds, and opens", async () => {
  const app = await chat("wire");
  await app.waitFor("text:14 步");
  await app.press("role:button[查看全部] >> nth=1");
  await app.waitFor("text:src/server/replay.ts");
  await app.press("text:src/lib/wire.ts >> nth=0");
  await app.waitFor("text:@@ reconnect() @@");
  expect(app.texts()).toContain("- socket.send(hello());");
  expect(app.texts()).not.toContain("+ replay.push(frames[0]);");
  await app.press("text:/展开全部 \\d+ 行/");
  await app.waitFor("text:+ replay.push(frames[0]);");
});

test("03i: a failed command says how, and where the rest is", async () => {
  const app = await chat("board");
  await app.waitFor("text:2 步");
  await app.press("role:button[查看全部]");
  await app.waitFor("text:Mori 的过程");
  await app.waitFor("text:退出 1");
  await app.press("text:/expected seq 41/");
  await app.waitFor(
    "text:输出太长，只保留了一部分；完整输出在 /tmp/eta/out-41.log",
  );
  expect(app.texts()).toContain("退出 1");
  await app.waitFor("id:tool-image");
});

test("03h: a direct chat draws its run in the same box as a group, and streams its words in it", async () => {
  const app = await chat("dm-xiaoman");
  await app.waitFor("text:/^思考过程 · [\\d,]+ 字$/");
  expect(app.shows("id:process-frame")).toBe(true);
  await app.waitFor("text:/weekly\\/2026-w45\\.md/");
  expect(app.shows("id:composer-target")).toBe(false);
  await app.waitFor("text:/周报写好了|The weekly report is ready/", {
    timeout: 8000,
  });
  // Still working: the words are in the box, not under it.
  expect(app.shows("id:process-frame")).toBe(true);
});

test("03a: a sent message queued behind a run can be pulled back or dropped", async () => {
  const app = await chat("wire", "chat-queue");
  await app.waitFor("text:The rollback needs tests too");
  expect(app.texts()).toContain("等待中 · 前面还有 1 条");
  expect(app.texts()).toContain("在「Website redesign」回复中 · 等待中");
  await app.press("text:拉回");
  // Nothing to put back in front of: the box was empty.
  await app.waitUntil(
    () => app.value("id:composer-input") === "The rollback needs tests too",
  );
  expect(app.shows("text:/^排队中/")).toBe(false);
});

test("03b: @ lists members, everyone and files, and a pick replaces only the token", async () => {
  const app = await chat("wire");
  await app.type("id:composer-input", "看下 @");
  await app.waitFor("text:忙碌 · 消息会排队");
  expect(app.texts()).toContain("所有人");
  expect(app.texts()).toContain("唤醒所有群成员");
  await app.waitFor("text:src/lib/wire.ts");
  await app.press("role:button[Mori]");
  await app.waitUntil(() => app.value("id:composer-input") === "看下 @Mori ");
  expect(app.shows("text:唤醒所有群成员")).toBe(false);
  // The chip says who the message now reaches.
  expect(app.texts()).toContain("Mori");
});

test("03g: empty, then a first message", async () => {
  const app = await chat("wire", "chat-empty");
  await app.waitFor("text:这里还没说过话。说一句就开始。");
  await app.type("id:composer-input", "你好");
  await app.press("id:composer-submit");
  await app.waitFor("text:你好");
  await app.waitFor("text:收到。", { timeout: 8000 });
});

test("03g: still reading", async () => {
  const app = await chat("wire", "chat-loading");
  await app.waitFor("text:正在读取对话…");
});

test("03g: archived blocks the box, and unarchiving frees it", async () => {
  const app = await chat("wire", "chat-archived");
  await app.waitFor("text:群已归档，取消归档后可以继续讨论。");
  expect(app.shows("id:composer-submit")).toBe(false);
  await app.press("role:button[取消归档]");
  await app.waitFor("id:composer-submit");
});

test("03g: no members", async () => {
  const app = await chat("wire", "chat-no-members");
  await app.waitFor("text:群里暂无智能体，邀请成员后可以继续讨论。");
  expect(app.shows("text:未选择智能体")).toBe(true);
});

test("03g: warnings that leave the box usable", async () => {
  const noModel = await chat("wire", "chat-no-model");
  await noModel.waitFor("text:阿澈 还没有选择模型。");
  const elsewhere = await chat("wire", "chat-elsewhere");
  await elsewhere.type("id:composer-input", "日志发我一份");
  await elsewhere.waitFor("text:阿澈 在「官网改版」回复，这条消息已排队。");
});

test("03f: what happened to a message, and the ways out", async () => {
  const app = await chat("wire", "chat-errors");
  await app.waitFor("text:已并入 阿澈 正在进行的回复");
  expect(app.texts()).toContain(
    "没有 @ 人，这个群也没有主理人。@ 一位成员，或设一位主理人。",
  );
  expect(app.texts()).toContain("已停止");
  expect(app.texts()).toContain("宿主重启了，这条回复没有写完。");
  await app.type("id:composer-input", "先备份再跑。");
  await app.press("id:composer-submit");
  await app.waitFor("text:网络连接失败，消息未送达。");
  await app.press("role:button[编辑]");
  await app.waitUntil(() => app.value("id:composer-input") === "先备份再跑。");
  await app.clear("id:composer-input");
  await app.type("id:composer-input", "日志发我一份。");
  await app.press("id:composer-submit");
  await app.waitFor("text:发送中…");
  await app.press("role:button[重新发送]");
  await app.waitFor("text:再跑一遍。 >> nth=1");
});

test("03d: the draft stays in its turn, opens in place and confirms into a card", async () => {
  const app = await chat("artifacts");
  await app.waitFor("text:写迁移回滚脚本");
  expect(app.texts()).toContain("待确认");
  expect(app.texts()).toContain("#128 重连后补发丢失的帧");
  expect(app.texts()).toContain("已完成 · 3 条评论");
  expect(app.texts()).toContain("待验收");
  expect(app.texts()).toContain("重连方案 · 第 2 版");
  expect(app.texts()).toContain("Mori 成为主理人，接替 阿澈。");
  expect(app.texts()).toContain(
    "这条消息已经用完 5 次唤醒；之后的 @ 只记入对话，等你再发言才会唤醒。",
  );
  await app.press("text:写迁移回滚脚本");
  await app.waitFor(
    "text:确认后创建任务，由提出它的智能体在独立 worktree里执行。",
  );
  await app.press("role:button[编辑并确认]");
  await app.waitFor("text:确认任务草稿");
  expect(app.value("label:标题")).toBe("写迁移回滚脚本");
  await app.clear("label:标题");
  await app.type("label:标题", "写回滚");
  await app.press("role:button[确认并开始]");
  await app.waitFor("text:/#\\d+ 写回滚/");
  expect(app.shows("text:待确认")).toBe(false);
});

test("a steward who left says so", async () => {
  const app = await open("../../../DevApp.tsx", {
    storage: { "eta.host": HOST, "eta.language": "zh" },
  });
  await app.waitFor("id:tab-conversations");
  await app.press("id:tab-conversations");
  // The fixture names it in English now; either spelling opens it.
  await app.waitFor("text:/^(产物版本|Artifact version)$/");
  await app.press("text:/^(产物版本|Artifact version)$/");
  await app.waitFor("text:Mori 退出了群，现在没有主理人。");
  expect(app.texts()).not.toContain("Mori 不再是主理人。");
});

test("03c2: # lists tasks, not after a word, and inserts the number", async () => {
  const app = await chat("wire");
  await app.type("id:composer-input", "C#");
  expect(app.shows("id:composer-menu")).toBe(false);
  await app.clear("id:composer-input");
  await app.type("id:composer-input", "看 #12");
  await app.waitFor("id:composer-menu");
  // The toolbar gives way to the list, as in the frame.
  expect(app.shows("id:composer-submit")).toBe(false);
  await app.press("id:composer-menu >> role:button >> nth=0");
  await app.waitUntil(() =>
    /^看 #\d+ $/.test(app.value("id:composer-input") ?? ""),
  );
  expect(app.shows("id:composer-menu")).toBe(false);
  expect(app.shows("id:composer-submit")).toBe(true);
});

test("03c2: a # query reads as a title too, and @ still works beside it", async () => {
  const app = await chat("wire");
  await app.type("id:composer-input", "，#重连");
  await app.waitFor("text:重连后补发丢失的帧");
  await app.clear("id:composer-input");
  await app.type("id:composer-input", "，@");
  await app.waitFor("text:忙碌 · 消息会排队");
});

test("markdown: replies render theirs, long ones fold, and a diff keeps its colours", async () => {
  const app = await chat("wire");
  await app.scroll("id:transcript", -300);
  await app.waitFor("text:帧格式我看过了，三处要改：");
  await app.waitFor("text:展开");
  await app.press("text:展开");
  await app.waitFor("text:收起");
  await app.waitFor("text:+ socket.send(hello({ since: last }));");
  expect(
    app.spanStyle("text:+ socket.send(hello({ since: last }));")?.color,
  ).not.toBe(app.spanStyle("text:帧格式我看过了，三处要改：")?.color);
});

test("history: going up loads what came before", async () => {
  const app = await chat("wire");
  await app.scroll("id:transcript", -600);
  await app.waitFor("text:第 8 条：现在断了就全量重拉。");
  await app.waitFor("text:新活动 · 阿澈、Mori");
  await app.press("text:新活动 · 阿澈、Mori");
  await app.waitFor("text:新活动 · 阿澈、Mori", { state: "gone" });
});

test("attachments: a picked image uploads and goes with the message", async () => {
  const app = await chat("wire", "chat-empty");
  app.onPick(() => [
    { name: "shot.png", type: "image/png", data: new Uint8Array([1, 2, 3, 4]) },
  ]);
  await app.press("id:composer-attach");
  await app.waitFor("text:shot.png");
  await app.type("id:composer-input", "看图");
  await app.press("id:composer-submit");
  await app.waitFor("text:看图");
  expect(app.picks().length).toBe(1);
});

test("a draft outlives leaving the conversation", async () => {
  const app = await chat("wire");
  await app.type("id:composer-input", "还没写完");
  await app.press("id:back");
  await app.press("text:wire 重连");
  await app.waitUntil(() => app.value("id:composer-input") === "还没写完");
});

test("the dark theme draws the same run", async () => {
  const app = await chat("wire");
  await app.setColorScheme("dark");
  await app.waitFor("text:14 步");
  expect(app.shows("role:button[停止]")).toBe(true);
});

test("the English copy follows the language", async () => {
  const app = await chat("wire", "", "en");
  await app.waitFor("text:14 steps");
  expect(app.shows("text:Message 阿澈…")).toBe(true);
});

test("03d: what Captain is told about its group proposal is not drawn; a review is one line", async () => {
  // Opened by the fixture's own title: `chat` looks it up in NAMES, which no longer matches it.
  const app = await open("../../../DevApp.tsx", {
    storage: { "eta.host": HOST, "eta.language": "en" },
  });
  await app.waitFor("id:tab-conversations");
  await app.press("id:tab-conversations");
  await app.waitFor("text:Artifact version");
  await app.press("text:Artifact version");
  await app.waitFor("text:Captain review · 2 observation(s)");
  const texts = app.texts();
  expect(texts.some((text) => text.includes("Your proposed group"))).toBe(
    false,
  );
  expect(texts.some((text) => text.includes("<captain-review>"))).toBe(false);
  expect(texts.filter((text) => text.startsWith("Captain review"))).toEqual([
    "Captain review · 2 observation(s)",
  ]);
});
