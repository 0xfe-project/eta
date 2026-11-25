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
  // The conversation list is there (its fixture titles are English).
  await app.waitFor("wire reconnect");
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

/** 07a: from 新对话 into the places flow, on mac-studio. */
const toWays = async (app: Awaited<ReturnType<typeof start>>) => {
  await app.press("label:新对话");
  await app.press("label:添加目录…");
  await app.waitFor("label:mac-studio");
  // nas is offline: greyed out, with why.
  expect(app.texts()).toContain("离线");
  await expect(app.press("label:nas")).rejects.toMatchObject({
    code: "ERR_NSH_TEST_DISABLED",
  });
  await app.press("label:mac-studio");
  await app.waitFor("label:搜索目录");
  for (const text of ["浏览…", "从 GitHub 克隆", "新建目录"])
    expect(app.texts()).toContain(text);
};

test("07a: searching lists what was used lately first, the phone's old ones included", async () => {
  const app = await start();
  await toWays(app);
  await app.waitFor("没有登录 gh，只能贴地址或 owner/repo");
  await app.press("label:搜索目录");
  // The phone's old `eta.recentDirectories` went to the host and come back as the host's.
  await app.waitFor("label:~/Developer/hutch");
  expect(app.texts()).toContain("~/Developer/eta");
  await app.type("id:place-query", "note");
  await app.waitFor("label:~/Developer/notes");
  await app.press("label:~/Developer/notes");
  await app.waitFor("mac-studio · ~/Developer/notes");
  await app.press("id:start");
  await app.waitUntil(() => app.count("id:start") === 0);
  await app.back();
  await app.waitFor("notes");
});

test("07a: a typed path is checked on the machine; one that is not there says so", async () => {
  const app = await start();
  await toWays(app);
  await app.press("label:搜索目录");
  await app.type("id:place-query", "~/nowhere");
  await app.waitFor("label:打开 ~/nowhere");
  await app.press("label:打开 ~/nowhere");
  await app.waitFor("这个目录不存在");
  await app.clear("id:place-query");
  await app.type("id:place-query", "~/Developer/eta");
  await app.waitFor("label:~/Developer/eta");
  await app.press("label:~/Developer/eta");
  await app.waitFor("id:start");
  // Already a project: that project, not a second one.
  expect(app.texts().filter((text) => text === "eta").length).toBe(1);
});

test("07a: browsing walks the machine's crumbs, shows hidden ones on asking, and picks where it is", async () => {
  const app = await start();
  await toWays(app);
  await app.press("label:浏览…");
  await app.waitFor("label:Developer");
  expect(app.texts()).not.toContain(".config");
  await app.press("label:隐藏目录");
  await app.waitFor(".config");
  await app.press("label:Developer");
  await app.waitFor("label:notes");
  await app.press("~");
  await app.waitFor("label:locked");
  await app.press("label:locked");
  await app.waitFor("没有权限读取这个目录");
  await app.press("~");
  await app.waitFor("label:Developer");
  await app.press("label:Developer");
  await app.press("label:notes");
  await app.waitFor("这里没有子目录，可以直接选择当前目录");
  await app.press("id:picker-choose");
  await app.waitFor("mac-studio · ~/Developer/notes");
});

test("07a: a new directory, made where it was put", async () => {
  const app = await start();
  await toWays(app);
  await app.press("label:新建目录");
  await app.waitFor("label:~");
  await app.type("id:place-query", "~/Dev");
  await app.waitFor("label:~/Developer");
  await app.press("label:~/Developer");
  await app.waitFor("在 ~/Developer 里新建");
  await app.type("id:place-query", "fresh");
  await app.waitFor("label:新建 ~/Developer/fresh");
  await app.press("label:新建 ~/Developer/fresh");
  await app.waitFor("mac-studio · ~/Developer/fresh");
});

test("07a: cloning owner/repo by HTTPS into the default place", async () => {
  const app = await start();
  await toWays(app);
  await app.press("label:从 GitHub 克隆");
  await app.type("id:place-query", "octocat/Hello-World");
  await app.waitFor("通过 HTTPS 克隆");
  expect(app.texts()).toContain("通过 SSH 克隆");
  // The first is HTTPS.
  await app.press("label:octocat/Hello-World >> nth=0");
  await app.waitFor("label:~/Developer/Hello-World");
  await app.press("label:~/Developer/Hello-World");
  await app.waitFor("mac-studio · ~/Developer/Hello-World");
});

test("07a′: the back arrow is a page back, and the first page's back leaves", async () => {
  const app = await start();
  await toWays(app);
  await app.press("label:搜索目录");
  await app.type("id:place-query", "eta");
  await app.press("id:back");
  await app.waitFor("label:新建目录");
  await app.press("label:搜索目录");
  // What was typed is still there.
  await app.waitFor("label:~/Developer/eta");
  await app.press("id:back");
  await app.press("id:back");
  await app.waitFor("label:mac-studio");
  await app.press("id:back");
  await app.waitFor("id:start");
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

/** New group, without waiting on the list's group names (the fixture spells them in English now). */
const newGroup = async () => {
  const app = await open("../../../DevApp.tsx", {
    storage: {
      "eta.host": JSON.stringify({ address: "fake", token: "" }),
      "eta.language": "zh",
    },
  });
  await app.waitFor("id:tab-conversations");
  await app.press("id:tab-conversations");
  await app.waitFor("id:create");
  await app.press("id:create");
  await app.waitFor("label:新建群");
  await app.press("label:新建群");
  await app.waitFor("id:group-name");
  return app;
};

test("07b: the steward is the first member chosen, another one, or none", async () => {
  const app = await newGroup();
  const seen = (text: string) =>
    app.texts().filter((each) => each === text).length;
  // Nobody chosen: nobody to lead.
  expect(app.shows("id:group-steward")).toBe(false);
  await app.press("label:Ache");
  await app.press("label:Mori");
  await app.waitFor("id:group-steward");
  expect(seen("Ache")).toBe(2);
  // The first one chosen going hands it to the next.
  await app.press("label:Ache");
  await app.waitUntil(() => seen("Mori") === 2);
  await app.press("label:Ache");
  expect(seen("Mori")).toBe(2);
  await app.press("id:group-steward");
  await app.waitFor("text:没有主理人");
  // Only who is chosen, and none.
  expect(seen("Xiaoman")).toBe(1);
  await app.press("role:button[Ache]");
  await app.waitUntil(() => seen("Ache") === 2 && seen("Mori") === 1);
  await app.press("id:create-group");
  await app.waitFor("text:/主理人：Ache$/");
});

test("07b: a group can start with no steward", async () => {
  const app = await newGroup();
  await app.press("label:Ache");
  await app.press("label:Mori");
  await app.press("id:group-steward");
  await app.press("label:没有主理人");
  await app.waitFor("text:没有主理人");
  await app.press("id:create-group");
  await app.waitFor("id:composer-input");
  await app.waitFor("text:eta");
  expect(app.shows("text:/主理人：/")).toBe(false);
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

test("07d: the agent made gets a group of its own (conversations.create), not agents.direct", async () => {
  const app = await start();
  await app.press("label:新建智能体");
  await app.type("id:agent-name", "代码审查");
  await app.press("id:agent-next");
  await app.waitFor("id:agent-create");
  await app.press("id:agent-create");
  await app.waitFor("id:chat-members");
  // A group of the agent alone is that agent's own chat: its name over the screen, and its own
  // page behind the header.
  expect(app.shows("text:/^代码审查$/")).toBe(true);
  expect(app.shows("label:智能体信息")).toBe(true);
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
