import { expect, open, test } from "nsh/test";

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
  expect(texts).toContain("wire 重连");
  expect(texts).toContain("阿澈");
  expect(texts).toContain("#128 重连后补发丢失的帧");
  expect(texts).toContain("#129 备份归档到 nas");
  await app.waitFor("text:重连方案 · 第 2 版");
  expect(app.texts()).toContain("产物 1");
  expect(texts).toContain("2 位成员");
  expect(texts).toContain("在这个群里还没和它说过话");
  await app.waitFor("text:claude-opus-5-5 · in 48.2k · out 6.1k");
  expect(app.texts()).toContain("断线重连后不丢帧、不重复，迁移能回滚。");
});

test("the menu edits the group and saves through conversations.update", async () => {
  const app = await start("group:wire");
  await app.waitFor("id:group-more");
  await app.press("id:group-more");
  await app.press("编辑群信息");
  await app.waitFor("id:edit-name");
  expect(app.value("id:edit-goal")).toBe("断线重连后不丢帧、不重复，迁移能回滚。");
  expect(app.value("id:edit-decided")).toBe("客户端带 last_seq，host 从那一行往后重放。");
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
  const open = () => app.count("text:#131 看板列宽记住上次拖动");
  const before = open();
  await app.press("id:related-131");
  await app.waitUntil(() => open() > before);
  await app.press("id:related-129");
  await app.waitUntil(() => app.count("text:#129 备份归档到 nas") === 1);
});

test("03l sets the conversation's steward and follows the project again", async () => {
  const app = await start("group:wire");
  await app.waitFor("主理人");
  await app.press("label:主理人");
  await app.waitFor("text:本对话的主理人");
  expect(app.texts()).toContain("项目「eta」的主理人：阿澈");
  await app.press("id:steward-agent-mori");
  await app.waitFor("text:Mori 主理人 · 排队中");
  await app.press("label:主理人");
  await app.press("id:steward-follow");
  await app.waitFor("text:阿澈 主理人 · 等待确认");
});

test("no steward needs the project: the row leads to its level", async () => {
  const app = await start("group:wire");
  await app.waitFor("主理人");
  await app.press("label:主理人");
  await app.press("id:steward-none");
  await app.press("id:project-steward-none");
  await app.waitFor("text:没有主理人");
  expect(app.shows("text:阿澈 主理人 · 等待确认")).toBe(false);
});

test("03k member sheet: stats, invite, remove with a confirmation", async () => {
  const app = await start("group:wire");
  await app.waitFor("id:member-agent-ache");
  await app.press("id:member-agent-ache");
  await app.waitFor("text:in 48.2k · out 6.1k · cache 210.0k");
  expect(app.texts()).toContain("42 tok/s");
  expect(app.texts()).toContain("tools 23");
  expect(app.texts()).toContain("单独和 阿澈 说");
  await app.press("移出群");
  await app.waitFor("text:把「阿澈」移出群？");
  await app.press("移出群 >> nth=0");
  await app.waitFor("text:1 位成员");
  await app.press("邀请");
  await app.press("id:invite-agent-xiaoman");
  await app.waitFor("text:2 位成员");
});

test("stop reaches the member's own reply", async () => {
  const app = await start("group:board");
  await app.waitFor("id:member-agent-mori");
  await app.press("id:member-agent-mori");
  await app.waitFor("text:步骤 1/2");
  await app.press("把列宽写进设置");
  await app.waitFor("text:步骤 2/2");
  await app.press("停止");
  await app.waitFor("text:停止", { state: "gone" });
});

test("只看 shows that member's rows", async () => {
  const app = await start("group:wire");
  await app.waitFor("id:member-agent-ache");
  await app.press("id:member-agent-ache");
  await app.press("只看 阿澈");
  await app.waitFor("text:迁移会锁 message 表大约 40 秒，得你定。");
});

test("basic info leads to 03h2, read-only", async () => {
  const app = await start("agent:agent-xiaoman");
  await app.waitFor("text:小满");
  for (const text of ["工作中", "mac-studio", "eta 内置", "gpt-5.1-codex", "跟随模型默认", "项目默认"])
    expect(app.texts()).toContain(text);
  expect(app.texts()).toContain("你负责每周把任务汇总成周报，只写做完的和受阻的，下周计划单列一节。");
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
  expect(app.openedUrls()).toEqual(["http://fake/preview/1.9999.sig/index.html"]);

  await app.press("下载");
  await app.waitFor("text:手机上只能下载已公开分享的版本，私有版本请在电脑上下载。");

  await app.press("公开分享");
  await app.waitFor("text:fake/share/7f3a91c2/");
  await app.press("复制");
  await app.waitFor("text:已复制");
  expect(app.clipboard()).toBe("http://fake/share/7f3a91c2/");
  await app.press("撤销分享");
  await app.waitFor("text:已撤销公开链接");

  await app.press("公开分享");
  await app.waitFor("text:fake/share/7f3a91c2/");
  await app.back();
  await app.press("下载");
  expect(app.openedUrls()).toEqual([
    "http://fake/preview/1.9999.sig/index.html",
    "http://fake/share/7f3a91c2/archive.zip",
  ]);
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

test("a group's routines are listed, and a group with none says nothing of them", async () => {
  const app = await start("group:artifacts");
  await app.waitFor("text:定时 1");
  expect(app.texts()).toContain("每周汇总");
  expect(app.texts()).not.toContain("定时 0");
});

test("a conversation that is gone says so", async () => {
  const app = await start("group:nope");
  await app.waitFor("text:这个对话已不存在");
  expect(app.shows("id:group-more")).toBe(false);
});
