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
  await app.waitFor("wire 重连");
  await app.press("id:create");
  await app.waitFor("新建智能体");
  return app;
};

test("04: the three ways in", async () => {
  const app = await start();
  for (const text of [
    "选一个项目和一位智能体",
    "选几位智能体，一起讨论一件事",
    "你对话、交代任务的对象",
  ])
    expect(app.texts()).toContain(text);
});

test("07: starts with the first project and agent, and back from the chat is the list", async () => {
  const app = await start();
  await app.press("label:新对话");
  await app.waitFor("id:start");
  for (const text of [
    "mac-studio · ~/Developer/eta",
    "mb-air · ~/site",
    "添加目录…",
  ])
    expect(app.texts()).toContain(text);
  await app.press("label:官网");
  await app.press("label:Mori");
  await app.press("id:start");
  await app.waitUntil(() => app.count("id:start") === 0);
  await app.back();
  await app.waitFor("id:tab-conversations");
  // A new group named by nobody bears the project's name.
  expect(app.texts().filter((text) => text === "官网").length).toBeGreaterThan(
    1,
  );
});

test("07a: walks to a directory, adds it as a project on start", async () => {
  const app = await start();
  await app.press("label:新对话");
  await app.press("label:添加目录…");
  await app.waitFor("label:Developer");
  expect(app.texts()).toContain("最近用过");
  expect(app.texts()).toContain("~/Developer/hutch");
  expect(app.texts()).toContain("已添加");
  expect(app.texts()).not.toContain(".config");
  await app.press("label:隐藏目录");
  await app.waitFor(".config");
  await app.press("label:Developer");
  await app.waitFor("label:notes");
  expect(app.texts()).not.toContain("最近用过");
  await app.press("label:notes");
  await app.waitFor("这里没有子目录，可以直接选择当前目录");
  await app.press("id:picker-choose");
  await app.waitFor("notes");
  await app.waitFor("mac-studio · ~/Developer/notes");
  await app.press("id:start");
  await app.waitUntil(() => app.count("id:start") === 0);
  await app.back();
  await app.waitFor("notes");
});

test("07a: a directory that is already a project is that project", async () => {
  const app = await start();
  await app.press("label:新对话");
  await app.press("label:添加目录…");
  await app.press("label:Developer");
  await app.press("label:eta");
  await app.waitFor("label:packages");
  await app.press("id:picker-choose");
  await app.waitFor("id:start");
  expect(app.texts().filter((text) => text === "eta").length).toBe(1);
});

test("07a′: the list's states", async () => {
  const app = await start();
  await app.press("label:新对话");
  await app.press("label:添加目录…");
  await app.waitFor("label:Developer");
  await app.type("id:picker-filter", "zzz");
  await app.waitFor("没有匹配的目录");
  await app.clear("id:picker-filter");
  await app.press("label:big");
  await app.waitFor("目录太多，只列出前 1000 个。用筛选或输入路径。");
  await app.press("~");
  await app.waitFor("label:locked");
  await app.press("label:locked");
  await app.waitFor("没有权限读取这个目录");
  await app.press("label:回到上一级");
  await app.waitFor("label:locked");
  await app.press("输入路径");
  await app.clear("id:picker-path");
  await app.type("id:picker-path", "/nowhere");
  await app.submit("id:picker-path");
  await app.waitFor("这个目录不存在");
  await app.press("取消");
  await app.press("id:picker-machine");
  await app.press("label:gpu-box");
  await app.waitFor("连不上这台机器");
  await app.waitFor("label:重试");
});

test("07b: a typed name and a goal; empty members can't go", async () => {
  const app = await start();
  await app.press("label:新建群");
  await app.waitFor("id:group-name");
  await expect(app.press("id:create-group")).rejects.toMatchObject({
    code: "ERR_NSH_TEST_DISABLED",
  });
  await app.type("id:group-name", "迁移小组");
  await app.type("id:group-goal", "这周把重连和迁移都发出去");
  await app.press("label:阿澈");
  await app.press("label:Mori");
  await app.press("id:create-group");
  await app.waitUntil(() => app.count("id:create-group") === 0);
  await app.back();
  await app.waitFor("迁移小组");
});

test("07b: a name left empty is the project's", async () => {
  const app = await start();
  await app.press("label:新建群");
  await app.press("id:group-project");
  await app.press("label:官网");
  await app.press("label:小满");
  await app.press("id:create-group");
  await app.waitUntil(() => app.count("id:create-group") === 0);
  await app.back();
  await app.waitFor("id:tab-conversations");
  expect(app.texts().filter((text) => text === "官网").length).toBeGreaterThan(
    1,
  );
});

test("07c, 07d: an agent, then its private chat", async () => {
  const app = await start();
  await app.press("label:新建智能体");
  await app.waitFor("id:agent-name");
  for (const text of ["跟随项目", "eta 内置", "gpt-5.1-codex", "跟随模型默认"])
    expect(app.texts()).toContain(text);
  await app.press("id:agent-next");
  await app.waitFor("请输入名称。");
  await app.type("id:agent-name", "代码审查");
  await app.press("id:agent-model");
  expect(app.texts()).toContain("Kimi for Coding");
  await expect(app.press("label:kimi-k2（不可用）")).rejects.toMatchObject({
    code: "ERR_NSH_TEST_DISABLED",
  });
  await app.press("label:gpt-5.1");
  await app.press("id:agent-next");
  await app.waitFor("id:agent-instructions");
  expect(app.texts()).toContain("项目默认");
  await app.press("id:agent-persona");
  await app.press("label:工程师");
  await app.type(
    "id:agent-instructions",
    "你负责审查 Pull Request，只指出会导致错误的问题。",
  );
  await app.press("id:agent-create");
  await app.waitUntil(() => app.count("id:agent-create") === 0);
  await app.back();
  await app.waitFor("id:tab-conversations");
  await app.press("label:私聊 1");
  await app.waitFor("代码审查");
});

test("07c: a runtime the machine lacks moves the draft to eta", async () => {
  const app = await start();
  await app.press("label:新建智能体");
  await app.press("id:agent-runtime");
  await app.press("label:Claude Code");
  await app.waitFor("运行时默认模型");
  await app.press("id:agent-machine");
  await app.waitFor("label:mb-air");
  await app.press("label:mb-air");
  await app.waitFor("mb-air 上没有 Claude Code，已换成 eta 内置");
  expect(app.texts()).toContain("gpt-5.1-codex");
});

test("07d: a failure stays with every field, and 重试创建 goes", async () => {
  const app = await start({ "eta.fake.scenario": "agent-create-fails" });
  await app.press("label:新建智能体");
  await app.type("id:agent-name", "代码审查");
  await app.press("id:agent-next");
  await app.waitFor("id:agent-create");
  await app.press("id:agent-create");
  await app.waitFor("创建失败：模型不可用");
  await app.waitFor("重试创建");
  await app.press("id:agent-create");
  await app.waitUntil(() => app.count("id:agent-create") === 0);
});
