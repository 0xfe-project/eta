import { expect, open, test } from "nsh/test";
import { lastObservedAt } from "../../../../../test/fixtures/member-context";

const start = async (route: string, scenario = "") => {
  const app = await open("../../../DevApp.tsx", {
    storage: {
      "eta.host": JSON.stringify({ address: "fake", token: "" }),
      "eta.language": "zh",
      "eta.fake.scenario": scenario,
      "eta.fake.route": route,
    },
  });
  return app;
};

test("03j shows the group's facts, tasks, artifacts, members and goal", async () => {
  const app = await start("group:wire");
  await app.waitFor("text:eta · mac-studio");
  const texts = app.texts();
  expect(texts).toContain("wire reconnect");
  expect(texts).toContain("Ache");
  expect(texts).toContain("#128 Backfill lost frames after reconnect");
  expect(texts).toContain("#129 Archive backup to nas");
  await app.waitFor("text:Reconnect plan · 第 2 版");
  expect(app.texts()).toContain("产物 1");
  expect(texts).toContain("2 位成员");
  expect(texts).toContain("在这个群里还没和它说过话");
  await app.waitFor(
    "text:claude-opus-5-5 · 50% · in 48.2k · out 6.1k · cache 210.0k",
  );
  expect(app.texts()).toContain(
    "No dropped or duplicated frames after reconnect, and the migration can roll back.",
  );
});

test("the menu edits the group and saves through conversations.update", async () => {
  const app = await start("group:wire");
  await app.waitFor("id:group-more");
  await app.press("id:group-more");
  await app.press("编辑群信息");
  await app.waitFor("id:edit-name");
  expect(app.value("id:edit-goal")).toBe(
    "No dropped or duplicated frames after reconnect, and the migration can roll back.",
  );
  expect(app.value("id:edit-decided")).toBe(
    "The client carries last_seq; the host replays from that line forward.",
  );
  await app.clear("id:edit-name");
  expect(app.enabled("保存")).toBe(true);
  await app.type("id:edit-name", "wire 补帧");
  await app.clear("id:edit-goal");
  await app.type("id:edit-goal", "回滚演练通过");
  await app.press("保存");
  await app.waitFor("text:回滚演练通过");
  expect(app.texts()).toContain("wire 补帧");
});

test("archiving flips the menu item", async () => {
  const app = await start("group:wire");
  await app.waitFor("id:group-more");
  await app.press("id:group-more");
  await app.press("归档");
  await app.waitFor("text:已归档");
  expect(app.shows("text:邀请")).toBe(false);
  await app.press("id:group-more");
  expect(app.texts()).toContain("取消归档");
});

test("related tasks link and unlink", async () => {
  const app = await start("group:wire");
  await app.waitFor("id:group-more");
  await app.press("id:group-more");
  await app.press("相关任务");
  const open = () =>
    app.count("text:#131 Board column width remembers last drag");
  const before = open();
  await app.press("id:related-131");
  await app.waitUntil(() => open() > before);
  await app.press("id:related-129");
  await app.waitUntil(() => app.count("text:#129 Archive backup to nas") === 1);
});

test("03l the steward is one of the members, or none", async () => {
  const app = await start("group:wire");
  await app.waitFor("主理人");
  await app.press("label:主理人");
  await app.waitFor("id:steward-agent-mori");
  expect(app.shows("id:steward-agent-ache")).toBe(true);
  expect(app.shows("id:steward-none")).toBe(true);
  // Not a member, and nothing of the project's.
  expect(app.shows("id:steward-agent-xiaoman")).toBe(false);
  expect(app.shows("id:steward-follow")).toBe(false);
  expect(app.shows("id:steward-project")).toBe(false);
  expect(app.shows("text:/项目「/")).toBe(false);
  await app.press("id:steward-agent-mori");
  await app.waitFor("text:Mori 主理人 · 排队中");
});

test("no steward is a choice of its own", async () => {
  const app = await start("group:wire");
  await app.waitFor("主理人");
  await app.press("label:主理人");
  await app.press("id:steward-none");
  await app.waitFor("text:没有主理人");
  expect(app.shows("text:/^(Ache|Ache) 主理人 · 等待确认$/")).toBe(false);
});

test("the steward leaving leaves the group with none", async () => {
  const app = await start("group:wire");
  // The fixture names its agents in English now.
  await app.waitFor("text:/^(Ache|Ache) 主理人 · 等待确认$/");
  await app.press("id:member-agent-ache");
  await app.press("移出群");
  await app.waitFor("text:/^把「(Ache|Ache)」移出群？$/");
  await app.press("移出群 >> nth=0");
  await app.waitFor("text:1 位成员");
  await app.waitFor("text:没有主理人");
  expect(app.shows("text:/^Mori 主理人/")).toBe(false);
});

test("03k member sheet: stats, invite, remove with a confirmation", async () => {
  const app = await start("group:wire");
  await app.waitFor("id:member-agent-ache");
  await app.press("id:member-agent-ache");
  await app.waitFor("text:in 48.2k · out 6.1k · cache 210.0k");
  expect(app.texts()).toContain("42 tok/s");
  expect(app.shows("text:/tools 23/")).toBe(true);
  expect(app.texts()).toContain("单独和 Ache 说");
  await app.press("移出群");
  await app.waitFor("text:把「Ache」移出群？");
  await app.press("移出群 >> nth=0");
  await app.waitFor("text:1 位成员");
  await app.press("邀请");
  await app.press("id:invite-agent-xiaoman");
  await app.waitFor("text:2 位成员");
});

test("talking to a member alone opens the chat of it alone (conversations.create), not agents.direct", async () => {
  const app = await start("group:wire");
  await app.waitFor("id:member-agent-ache");
  await app.press("id:member-agent-ache");
  await app.press("单独和 Ache 说");
  await app.waitFor("id:chat-members");
  // A group of the agent alone is that agent's own chat: its name over the screen, and its own
  // page behind the header.
  expect(app.shows("text:/^Ache$/")).toBe(true);
  expect(app.shows("label:智能体信息")).toBe(true);
});

test("stop reaches the member's own reply", async () => {
  const app = await start("group:board");
  await app.waitFor("id:member-agent-mori");
  await app.press("id:member-agent-mori");
  await app.waitFor("text:步骤 1/2");
  await app.press("Write column widths into settings");
  await app.waitFor("text:步骤 2/2");
  await app.press("停止");
  await app.waitFor("text:停止", { state: "gone" });
});

test("只看 shows that member's rows", async () => {
  const app = await start("group:wire");
  await app.waitFor("id:member-agent-ache");
  await app.press("id:member-agent-ache");
  await app.press("只看 Ache");
  await app.waitFor(
    "text:The migration will lock the message table for about 40 seconds — that's your call.",
  );
});

test("basic info leads to 03h2, read-only", async () => {
  const app = await start("agent:agent-xiaoman");
  await app.waitFor("text:Xiaoman");
  for (const text of [
    "工作中",
    "mac-studio",
    "eta 内置",
    "gpt-5.1-codex",
    "跟随模型默认",
    "项目默认",
  ])
    expect(app.texts()).toContain(text);
  expect(app.texts()).toContain(
    "Each week you compile the tasks into a weekly report: only what's done and what's blocked, with next week's plan in its own section.",
  );
});

test("03n picks a version, 03o shares, copies and revokes", async () => {
  const app = await start("artifact:reconnect", "relative-urls");
  await app.waitFor("text:第 2 版（最新）");
  await app.waitFor("id:artifact-page");
  await app.press("id:artifact-version");
  await app.press("id:version-1");
  await app.waitFor("text:第 1 版");
  await app.waitFor("id:artifact-page");

  await app.press("新窗口打开");
  expect(app.openedUrls()).toEqual([
    "http://fake/preview/1.9999.sig/index.html",
  ]);

  await app.press("下载");
  await app.waitFor("text:/没有成功/");

  await app.press("公开分享");
  await app.waitFor("text:fake/share/7f3a91c2/");
  await app.press("复制");
  await app.waitFor("text:已复制");
  expect(app.clipboard()).toBe("http://fake/share/7f3a91c2/");
  await app.press("撤销分享");
  await app.waitFor("text:已撤销公开链接");

  await app.press("公开分享");
  await app.waitFor("text:fake/share/7f3a91c2/");
});

test("a download-only version says so", async () => {
  const app = await start("artifact:scripts");
  await app.waitFor("text:这个版本不能在这里打开");
  await app.press("新窗口打开");
  expect(app.openedUrls()).toEqual([]);
});

test("a preview the host refuses can be asked for again", async () => {
  const app = await start("artifact:reconnect", "preview-refused");
  await app.waitFor("text:无法打开这个产物");
  await app.press("重试");
  await app.waitFor("id:artifact-page");
});

test("a group lists no routines: they are Captain's, not a group's", async () => {
  const app = await start("group:artifacts");
  await app.waitFor("id:group-more");
  expect(app.texts().some((text) => text.startsWith("定时"))).toBe(false);
});

test("a conversation that is gone says so", async () => {
  const app = await start("group:nope");
  await app.waitFor("text:这个对话已不存在");
  expect(app.shows("id:group-more")).toBe(false);
});

test("a task that runs stays over a queued one of its status, even one that moved later", async () => {
  const app = await start("group:board", "queued-newer");
  await app.waitFor("text:#133 Run history supports pagination");
  const texts = app.texts();
  expect(
    texts.indexOf("#131 Board column width remembers last drag"),
  ).toBeLessThan(texts.indexOf("#133 Run history supports pagination"));
});

test("03k a member's context: how full, when last compacted, and compacting it", async () => {
  const app = await start("group:wire");
  await app.waitFor("id:member-agent-ache");
  await app.press("id:member-agent-ache");
  await app.waitFor("id:member-context");
  await app.press("id:member-context");
  await app.waitFor("id:context-panel");
  await app.waitFor("text:50% · 64,000 / 128,000 tokens");
  expect(app.texts()).toContain("上次压缩：没有");
  await app.press("id:context-compact");
  await app.waitFor("text:已压缩上下文。");
  await app.waitFor("text:/^上次压缩：\\d+:\\d\\d$/");
});

for (const [scenario, detail] of [
  ["acp", "50% · 64,000 / 128,000 tokens"],
  ["codex", "25% · 32,000 / 128,000 tokens"],
  ["missing", "N/A · 尚未上报上下文读数"],
  ["legacy", "N/A · 缺少可靠的最近调用读数或窗口"],
  ["noWindow", "N/A · 缺少有效的上下文窗口"],
  ["compacted", "N/A · 等待压缩后的新读数"],
  ["overflow", "N/A · 上下文读数超出有效范围"],
  ["empty", "0% · 0 / 128,000 tokens"],
  ["full", "100% · 128,000 / 128,000 tokens"],
  ["switched", "N/A · 等待新模型的读数"],
  ["estimated", "约 13% · 16,000 / 128,000 tokens"],
  [
    "lastObserved",
    `15% · 19,010 / 128,000 tokens · 上次查询 ${new Date(lastObservedAt).toLocaleString("zh-CN")}`,
  ],
] as const) {
  test(`member context replay: ${scenario}`, async () => {
    const app = await start("group:wire", `context-${scenario}`);
    await app.press("id:member-agent-ache");
    await app.press("id:member-context");
    await app.waitFor(`text:${detail}`);
    if (scenario === "acp")
      expect(app.texts()).toContain("in — · out — · cache —");
    if (scenario === "codex")
      expect(app.texts()).toContain("in 240.0k · out 0 · cache 1.0k (部分)");
  });
}
