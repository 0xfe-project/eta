import type { ProjectView, RecentPlace } from "@eta/client-contracts";
import type { FakePlaces } from "@/test-places";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  rstest,
} from "@rstest/core";
import { act } from "react";
import { setWire } from "@/lib/wire";
import { fakePlaces } from "@/test-places";
import {
  agentView,
  conversationView,
  machineView,
  productHost,
  projectView,
} from "@/test-product";
import { button, cleanup, click, flush, mount } from "@/test-render";
import { NewConversationDialog } from "./new-conversation-dialog";
import { useWorkspaceStore } from "./workspace-store";

const state = rstest.hoisted(() => ({
  navigate: rstest.fn(),
}));

rstest.mock("@tanstack/react-router", () => ({
  useNavigate: () => state.navigate,
}));

const HOME = "/home/me";
const eta = projectView({
  id: "p1",
  name: "eta",
  path: `${HOME}/eta`,
  display: "~/eta",
});
const house = projectView({
  id: "p2",
  name: "house",
  path: `${HOME}/house`,
  display: "~/house",
});
const primary = machineView({
  id: "m1",
  name: "主机",
  kind: "primary",
  home: HOME,
});
const agents = [
  agentView({ id: "a1", name: "乐子人" }),
  agentView({ id: "a2", name: "装配检查" }),
  agentView({ id: "a3", name: "文档员" }),
];

/** The projects as `places.recent` has them: every client's recent places come from the host. */
const recentOf = (projects: readonly ProjectView[]): RecentPlace[] =>
  projects
    .filter((project) => project.kind === "project" && !project.archived)
    .map((project, index) => ({
      machineId: project.machineId,
      path: project.path,
      display: project.display,
      projectId: project.id,
      parent: { path: HOME, display: "~" },
      usedAt: 100 - index,
    }));

let host: ReturnType<typeof productHost>;
let places: FakePlaces;
async function start({
  projects = [eta, house] as ProjectView[],
  people = agents,
  machines = [primary],
  projectId = undefined as string | undefined,
  gh = "signed_out" as "ready" | "signed_out" | "missing",
  git = true,
  recent = undefined as RecentPlace[] | undefined,
  importFails = false,
} = {}) {
  host = productHost({
    agents: people,
    projects,
    machines,
    recent: recent ?? recentOf(projects),
  });
  places = fakePlaces(host, {
    home: HOME,
    dirs: [
      `${HOME}/eta`,
      `${HOME}/house`,
      `${HOME}/fresh`,
      `${HOME}/Developer`,
      `${HOME}/.config`,
      `${HOME}/locked`,
    ],
    denied: [`${HOME}/locked`],
    git: [`${HOME}/eta`],
    capabilities: { gh, git },
    repos: [
      {
        id: "gh:0xfe-project/eta",
        nameWithOwner: "0xfe-project/eta",
        cloneUrl: "0xfe-project/eta",
        description: "the app",
        updatedAt: null,
      },
    ],
  });
  if (importFails)
    host.handle("places.importRecent", () => {
      throw new Error("not now");
    });
  host.handle("projects.create", (args) => ({
    project: projectView({
      id: "made",
      path: (args as { path: string }).path,
    }),
    existed: false,
  }));
  host.handle("conversations.create", () => ({
    conversation: conversationView({ id: "c-new" }),
  }));
  // The form lives in a dialog; the store opens it, and the dialog reads who it is for.
  useWorkspaceStore.setState({ newConversation: { open: true, projectId } });
  await mount(<NewConversationDialog />);
  await flush();
}

beforeEach(() => {
  useWorkspaceStore.setState({ workspace: {} });
});

afterEach(async () => {
  await cleanup();
  setWire(undefined);
  state.navigate.mockClear();
  useWorkspaceStore.setState({ newConversation: { open: false } });
});

/** The dialog's contents are portalled out of the container it was mounted in. */
const body = () => document.body;
const isOpen = () => useWorkspaceStore.getState().newConversation.open;

const labelled = (text: string) => button(body(), text);
const options = () => [
  ...document.querySelectorAll<HTMLButtonElement>('[role="option"]'),
];
const option = (text: string) =>
  options().find((candidate) => candidate.textContent?.includes(text));
const selected = () =>
  options().find(
    (candidate) => candidate.getAttribute("aria-selected") === "true",
  )?.textContent;
const take = async (text: string) => {
  await click(option(text));
  await flush(20);
};
const box = () =>
  document.querySelector<HTMLInputElement>(
    '[role="dialog"] input[placeholder]',
  )!;
const placeholder = () => box().getAttribute("placeholder");
const type = async (text: string) => {
  await act(async () => {
    const input = box();
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  // Past the moment the flow waits for typing to settle, and the machine's answer.
  await flush(200);
  await flush(20);
};
/** The search page's recent row of a project, which is how a project is chosen again. */
const pickProject = async (name: string) => {
  if (placeholder() === "选择机器…") await take("主机");
  if (placeholder() !== "按名字搜，或输入路径…") await take("搜索目录");
  await take(`~/${name}`);
};
const begin = async () => {
  await click(labelled("开始"));
  await flush();
};
const back = async () => {
  await click(labelled("上一步"));
  await flush();
};

const memberRow = (name: string) =>
  [...document.querySelectorAll<HTMLElement>("li")].find((row) =>
    row.textContent?.includes(name),
  )!;
const tick = async (name: string) =>
  click(memberRow(name).querySelector('[role="checkbox"]'));
const ticked = (name: string) =>
  memberRow(name)
    .querySelector('[role="checkbox"]')!
    .getAttribute("aria-checked") === "true";
const stewardButton = (name: string) =>
  memberRow(name).querySelector<HTMLButtonElement>("button[aria-pressed]");
const steward = () =>
  [...document.querySelectorAll<HTMLElement>("li")]
    .filter((row) => row.querySelector('button[aria-pressed="true"]') !== null)
    .map((row) => row.textContent);

const onMembers = () =>
  document
    .querySelector('[aria-current="step"]')!
    .textContent!.includes("成员");
const calls = () =>
  host.calls
    .filter((call) => call.action === "create")
    .map((call) => [`${call.target}.${call.action}`, call.args]);
const placeCalls = (action: string) =>
  host.calls
    .filter((call) => call.target === "places" && call.action === action)
    .map((call) => call.args);

async function press(element: Element, key: string) {
  await act(async () => {
    element.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  });
  await flush(20);
}

const escape = () => press(document.activeElement ?? body(), "Escape");
const key = (name: string) => press(box(), name);

describe("第一步：机器和方式", () => {
  it("只有一台机器时直接是四种方式，做不到的写明原因", async () => {
    await start();
    expect(placeholder()).toBe("怎么添加？");
    expect(options().map((row) => row.textContent)).toEqual([
      "搜索目录在 主机 上找一个目录",
      "浏览…一层一层点进去",
      "从 GitHub 克隆没有登录 gh，只能贴地址或 owner/repo",
      "新建目录建一个空目录",
    ]);
  });

  it("没装 git 时克隆置灰，写明原因", async () => {
    await start({ git: false });
    const github = option("从 GitHub 克隆")!;
    expect(github.disabled).toBe(true);
    expect(github.textContent).toContain("这台机器没装 git");
    // The arrows step over it.
    await key("ArrowDown");
    await key("ArrowDown");
    expect(selected()).toContain("新建目录");
  });

  it("多台机器时先选机器：离线和 SSH 的置灰，写明原因", async () => {
    await start({
      machines: [
        primary,
        machineView({ id: "m2", name: "gpu", kind: "daemon", home: "/g" }),
        machineView({
          id: "m3",
          name: "attic",
          kind: "daemon",
          status: "offline",
        }),
        machineView({ id: "m4", name: "nas", kind: "ssh" }),
      ],
    });
    expect(placeholder()).toBe("选择机器…");
    expect(options().map((row) => [row.textContent, row.disabled])).toEqual([
      ["主机本机", false],
      ["gpu远程", false],
      ["attic离线", true],
      ["nas暂不支持 SSH 机器", true],
    ]);
    await key("ArrowDown");
    await key("Enter");
    expect(placeholder()).toBe("怎么添加？");
    expect(option("搜索目录")!.textContent).toContain("在 gpu 上找一个目录");
    await take("新建目录");
    await take("~");
    await type("made-on-gpu");
    await key("Enter");
    expect(placeCalls("mkdir")).toEqual([
      { machineId: "m2", parent: "/home/me", name: "made-on-gpu" },
    ]);
    await begin();
    expect(calls()[0]![1]).toMatchObject({ machineId: "m2" });
  });

  it("Esc 一页一页退回去，第一页才关闭；退回去再进来输入还在", async () => {
    await start();
    await take("搜索目录");
    await type("fre");
    await escape();
    expect(placeholder()).toBe("怎么添加？");
    expect(isOpen()).toBe(true);
    await take("搜索目录");
    expect(box().value).toBe("fre");
    await escape();
    await escape();
    expect(isOpen()).toBe(false);
  });
});

describe("搜索目录", () => {
  it("没输入时列出最近，输入后最近按同一规则过滤，后面接机器的结果", async () => {
    await start();
    await take("搜索目录");
    expect(options().map((row) => row.textContent)).toEqual([
      "~/eta已添加",
      "~/house已添加",
    ]);
    await type("fre");
    expect(options().map((row) => row.textContent)).toEqual(["~/fresh"]);
    await type("eta");
    expect(options().map((row) => row.textContent)).toEqual(["~/eta已添加"]);
  });

  it("用键盘选中机器上找到的目录，进第二步时是新项目", async () => {
    await start();
    await take("搜索目录");
    await type("fresh");
    await key("Enter");
    expect(onMembers()).toBe(true);
    expect(body().textContent).toContain("~/fresh");
    expect(body().textContent).toContain("新项目");
    await begin();
    expect(calls()[0]).toEqual([
      "projects.create",
      { path: `${HOME}/fresh`, machineId: "m1" },
    ]);
  });

  it("输入的路径排第一，回车在机器上检查；不存在就说出来留在原页，已列出的不重复", async () => {
    await start();
    await take("搜索目录");
    await type("~/.conf");
    expect(options().map((row) => row.textContent)).toEqual([
      "打开 ~/.conf",
      "~/.config",
    ]);
    expect(selected()).toBe("打开 ~/.conf");
    await key("Enter");
    expect(placeCalls("resolve")).toEqual([
      { machineId: "m1", path: "~/.conf" },
    ]);
    expect(onMembers()).toBe(false);
    expect(body().textContent).toContain("这个目录不存在");
    await type("~/.config");
    expect(options().map((row) => row.textContent)).toEqual(["~/.config"]);
    await key("Enter");
    expect(onMembers()).toBe(true);
    expect(body().textContent).toContain("~/.config");
  });

  it("已是项目的路径按项目处理，不重复添加", async () => {
    await start();
    await pickProject("eta");
    expect(body().textContent).not.toContain("新项目");
    await begin();
    expect(calls()).toEqual([
      [
        "conversations.create",
        { projectId: "p1", agentIds: ["a1"], stewardId: "a1" },
      ],
    ]);
  });
});

describe("浏览", () => {
  it("一层层点进去，面包屑由机器给，选当前目录进第二步", async () => {
    await start();
    await take("浏览…");
    const crumbs = () =>
      [...document.querySelectorAll("nav button")].map(
        (crumb) => crumb.textContent,
      );
    expect(crumbs()).toEqual(["~"]);
    expect(option(".config")).toBeUndefined();
    await click(document.querySelector('[role="checkbox"]'));
    await flush(20);
    expect(option(".config")).toBeDefined();
    await take("fresh");
    expect(crumbs()).toEqual(["~", "fresh"]);
    expect(selected()).toBe("就用 ~/fresh");
    await key("Enter");
    expect(onMembers()).toBe(true);
    expect(body().textContent).toContain("~/fresh");
  });

  it("读不了的目录说出原因，面包屑还在，能走回去", async () => {
    await start();
    await take("浏览…");
    await take("locked");
    expect(body().textContent).toContain("没有权限读取这个目录");
    const crumbs = [
      ...document.querySelectorAll<HTMLButtonElement>("nav button"),
    ];
    expect(crumbs.map((crumb) => crumb.textContent)).toEqual(["~"]);
    await click(crumbs[0]);
    await flush(20);
    expect(option("fresh")).toBeDefined();
    expect(body().textContent).not.toContain("没有权限读取这个目录");
  });
});

describe("从 GitHub 克隆", () => {
  it("没登录 gh 时贴 owner/repo，选 HTTPS，放到默认位置，克隆完直接进第二步", async () => {
    await start();
    await take("从 GitHub 克隆");
    await type("octocat/Hello-World");
    expect(options().map((row) => row.textContent)).toEqual([
      "octocat/Hello-World通过 HTTPS 克隆",
      "octocat/Hello-World通过 SSH 克隆",
    ]);
    await key("Enter");
    expect(selected()).toBe("~/Developer/Hello-World放在 ~/Developer");
    await key("Enter");
    expect(placeCalls("clone")).toEqual([
      {
        machineId: "m1",
        url: "octocat/Hello-World",
        protocol: "https",
        parent: `${HOME}/Developer`,
      },
    ]);
    places.progress(42);
    await flush(20);
    expect(body().textContent).toContain("正在克隆到 ~/Developer/Hello-World");
    expect(body().textContent).toContain("42%");
    places.finish("done");
    await flush(20);
    expect(onMembers()).toBe(true);
    expect(body().textContent).toContain("~/Developer/Hello-World");
  });

  it("登录了 gh 时列出仓库；克隆失败写明原因，Esc 能停下正在跑的克隆", async () => {
    await start({ gh: "ready" });
    expect(option("从 GitHub 克隆")!.textContent).toContain("搜你的仓库");
    await take("从 GitHub 克隆");
    await type("eta");
    expect(options().map((row) => row.textContent)).toEqual([
      "0xfe-project/etathe app",
    ]);
    await key("Enter");
    await key("Enter");
    places.finish("failed", { code: "auth" });
    await flush(20);
    expect(body().textContent).toContain("认证失败");
    expect(onMembers()).toBe(false);
    await key("Enter");
    await escape();
    expect(placeCalls("cancelClone")).toEqual([{ cloneId: "clone-2" }]);
    await flush(20);
    expect(body().textContent).toContain("克隆已停止");
    expect(isOpen()).toBe(true);
  });
});

describe("新建目录", () => {
  it("先选父目录，再输名字，回车在机器上新建，进第二步", async () => {
    await start();
    await take("新建目录");
    expect(selected()).toBe("~");
    await type("~/Dev");
    await take("~/Developer");
    expect(placeholder()).toBe("新目录的名字");
    await type("new-thing");
    expect(selected()).toBe("新建 ~/Developer/new-thing");
    await key("Enter");
    expect(placeCalls("mkdir")).toEqual([
      { machineId: "m1", parent: `${HOME}/Developer`, name: "new-thing" },
    ]);
    expect(onMembers()).toBe(true);
    expect(body().textContent).toContain("~/Developer/new-thing");
  });

  it("重名时说出来，名字还在", async () => {
    await start();
    await take("新建目录");
    await take("~");
    await type("fresh");
    await key("Enter");
    expect(body().textContent).toContain("那里已经有同名的东西了");
    expect(box().value).toBe("fresh");
    expect(onMembers()).toBe(false);
  });
});

describe("只有一位智能体", () => {
  it("选好目录就直接开始", async () => {
    await start({ people: [agents[0]!] });
    expect(labelled("下一步")).toBeUndefined();
    await take("搜索目录");
    await type("fresh");
    await key("Enter");
    expect(calls()).toEqual([
      ["projects.create", { path: `${HOME}/fresh`, machineId: "m1" }],
      [
        "conversations.create",
        { projectId: "made", agentIds: ["a1"], stewardId: "a1" },
      ],
    ]);
    expect(isOpen()).toBe(false);
  });

  it("失败也留在第二步，把原因说出来", async () => {
    await start({ people: [agents[0]!] });
    host.handle("projects.create", () => {
      throw new Error("no such directory");
    });
    await take("搜索目录");
    await type("fresh");
    await key("Enter");
    expect(onMembers()).toBe(true);
    expect(body().textContent).toContain("no such directory");
    expect(isOpen()).toBe(true);
  });
});

describe("最近目录搬到 host", () => {
  it("浏览器里旧的 recentDirectories 交给 host 一次，然后清掉", async () => {
    useWorkspaceStore.setState({
      workspace: {
        recentDirectories: { m1: [`${HOME}/old`, `${HOME}/older`] },
      },
    });
    await start();
    await flush(20);
    expect(placeCalls("importRecent")).toEqual([
      { recent: { m1: [`${HOME}/old`, `${HOME}/older`] } },
    ]);
    expect(
      useWorkspaceStore.getState().workspace.recentDirectories,
    ).toBeUndefined();
    await cleanup();
    setWire(undefined);
    await start();
    await flush(20);
    expect(placeCalls("importRecent")).toEqual([]);
  });

  it("host 没收下时留着，下次再交", async () => {
    useWorkspaceStore.setState({
      workspace: { recentDirectories: { m1: [`${HOME}/old`] } },
    });
    await start({ importFails: true });
    await flush(20);
    expect(placeCalls("importRecent")).toHaveLength(1);
    expect(
      useWorkspaceStore.getState().workspace.recentDirectories?.m1,
    ).toEqual([`${HOME}/old`]);
  });
});

describe("第二步：成员", () => {
  it("默认第一位智能体，它就是主理人：项目没有主理人可跟", async () => {
    await start();
    await pickProject("eta");
    expect(ticked("乐子人")).toBe(true);
    expect(ticked("装配检查")).toBe(false);
    expect(steward()).toHaveLength(1);
    expect(steward()[0]).toContain("乐子人");
    await begin();
    expect(calls()).toEqual([
      [
        "conversations.create",
        { projectId: "p1", agentIds: ["a1"], stewardId: "a1" },
      ],
    ]);
  });

  it("一次写入多位成员，主理人跟选的走", async () => {
    await start();
    await pickProject("eta");
    await tick("文档员");
    await tick("装配检查");
    await click(stewardButton("文档员"));
    await begin();
    expect(calls()).toEqual([
      [
        "conversations.create",
        { projectId: "p1", agentIds: ["a1", "a3", "a2"], stewardId: "a3" },
      ],
    ]);
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/",
      search: { group: "c-new" },
    });
    expect(isOpen()).toBe(false);
  });

  it("再按一次主理人就是没有主理人，照样能开始", async () => {
    await start();
    await pickProject("eta");
    await tick("文档员");
    await click(stewardButton("乐子人"));
    expect(steward()).toEqual([]);
    expect(stewardButton("乐子人")!.textContent).toBe("设为主理人");
    expect(stewardButton("文档员")!.textContent).toBe("设为主理人");
    expect(labelled("开始")!.disabled).toBe(false);
    // Somebody new joining does not undo the choice.
    await tick("装配检查");
    expect(steward()).toEqual([]);
    await begin();
    expect(calls()).toEqual([
      [
        "conversations.create",
        { projectId: "p1", agentIds: ["a1", "a3", "a2"], stewardId: null },
      ],
    ]);
  });

  it("没勾的行没有主理人按钮", async () => {
    await start();
    await pickProject("eta");
    expect(stewardButton("装配检查")).toBeNull();
    await tick("装配检查");
    expect(stewardButton("装配检查")!.textContent).toBe("设为主理人");
    expect(stewardButton("乐子人")!.textContent).toBe("主理人");
  });

  it("取消主理人后下一位已选成员接任，没人选时不能开始，再勾的第一位是主理人", async () => {
    await start();
    await pickProject("eta");
    await tick("文档员");
    await tick("装配检查");
    await tick("乐子人");
    expect(steward()[0]).toContain("文档员");
    await tick("装配检查");
    await tick("文档员");
    expect(steward()).toEqual([]);
    expect(labelled("开始")!.disabled).toBe(true);
    await tick("装配检查");
    expect(steward()[0]).toContain("装配检查");
    expect(labelled("开始")!.disabled).toBe(false);
  });

  it("动过的选择回到第一步改目录还在", async () => {
    await start();
    await pickProject("eta");
    await tick("文档员");
    await click(stewardButton("文档员"));
    await back();
    await pickProject("house");
    expect(ticked("乐子人")).toBe(true);
    expect(ticked("文档员")).toBe(true);
    expect(steward()[0]).toContain("文档员");
  });

  it("一个都没选时才重新套用默认", async () => {
    await start();
    await pickProject("house");
    await tick("乐子人");
    await back();
    await pickProject("eta");
    expect(ticked("乐子人")).toBe(true);
    expect(steward()[0]).toContain("乐子人");
  });

  it("绑在别的机器上的智能体带机器名，在那台机器上就不带", async () => {
    const gpu = machineView({ id: "m2", name: "gpu", kind: "daemon" });
    await start({
      machines: [primary, gpu],
      people: [
        agents[0]!,
        agentView({ id: "a4", name: "研究员", machineId: "m2" }),
        agentView({ id: "a5", name: "本机", machineId: "m1" }),
      ],
    });
    await pickProject("eta");
    expect(memberRow("研究员").textContent).toContain("gpu");
    expect(memberRow("本机").textContent).not.toContain("主机");
  });

  it("写出每一位的运行方式", async () => {
    await start({
      people: [
        agentView({ id: "a4", name: "甲", runtime: "claude" }),
        agentView({ id: "a5", name: "乙", runtime: "eta" }),
      ],
    });
    await pickProject("eta");
    expect(memberRow("甲").textContent).toContain("Claude Code");
    expect(memberRow("乙").textContent).toContain("eta 内置");
  });

  it("智能体超过 8 位才有搜索", async () => {
    const many = Array.from({ length: 9 }, (_, index) =>
      agentView({ id: `n${index}`, name: `智能体${index}` }),
    );
    await start({ people: many.slice(0, 8) });
    await pickProject("eta");
    expect(document.querySelector('input[aria-label="搜索"]')).toBeNull();
    await cleanup();
    await start({ people: many });
    await pickProject("eta");
    expect(document.querySelector('input[aria-label="搜索"]')).not.toBeNull();
  });

  it("没有智能体时说出来，不能开始", async () => {
    await start({ people: [] });
    await pickProject("eta");
    expect(body().textContent).toContain("还没有智能体");
    expect(labelled("开始")!.disabled).toBe(true);
  });

  it("host 拒绝时留在第二步说出原因，选择不丢，再按能重试", async () => {
    await start();
    await pickProject("eta");
    await tick("文档员");
    host.handle("conversations.create", () => {
      throw new Error("no such agent: a3");
    });
    await begin();
    expect(body().textContent).toContain("no such agent: a3");
    expect(onMembers()).toBe(true);
    expect(ticked("文档员")).toBe(true);
    expect(state.navigate).not.toHaveBeenCalled();
    host.handle("conversations.create", () => ({
      conversation: conversationView({ id: "c-new" }),
    }));
    await begin();
    expect(state.navigate).toHaveBeenCalledTimes(1);
  });

  it("连按两下只开一个对话", async () => {
    await start();
    await pickProject("eta");
    await act(async () => {
      labelled("开始")!.click();
      labelled("开始")!.click();
    });
    await flush();
    expect(calls()).toHaveLength(1);
  });
});

describe("从项目里新建", () => {
  it("跳过第一步，上一步回到那台机器的方式页", async () => {
    await start({
      projectId: "p2",
      machines: [
        primary,
        machineView({ id: "m2", name: "gpu", kind: "daemon" }),
      ],
    });
    expect(onMembers()).toBe(true);
    await back();
    expect(onMembers()).toBe(false);
    expect(placeholder()).toBe("怎么添加？");
    expect(body().textContent).toContain("主机");
  });

  it("开在哪个项目就在哪个项目，即使它不是第一个", async () => {
    await start({ projectId: "p2" });
    await begin();
    expect(calls()[0]![1]).toMatchObject({ projectId: "p2" });
  });

  it("不能开对话的项目（智能体自己的工作区）从第一步开始", async () => {
    await start({
      projectId: "own",
      projects: [
        eta,
        projectView({ id: "own", path: "/own", kind: "agent_home" }),
      ],
    });
    expect(onMembers()).toBe(false);
  });
});

describe("关掉和 Esc", () => {
  it("中途关闭什么都不写", async () => {
    await start();
    await pickProject("house");
    await click(labelled("取消"));
    await flush();
    expect(isOpen()).toBe(false);
    expect(calls()).toEqual([]);
    expect(placeCalls("remember")).toEqual([]);
  });

  it("开始之后才记住用过的目录，记在 host 上", async () => {
    await start();
    await pickProject("house");
    expect(placeCalls("remember")).toEqual([]);
    await begin();
    expect(placeCalls("remember")).toEqual([
      { machineId: "m1", path: `${HOME}/house` },
    ]);
  });

  it("第二步 Esc 退回第一步，第一步一页页退，最后才关闭", async () => {
    await start();
    await pickProject("eta");
    await escape();
    expect(onMembers()).toBe(false);
    expect(isOpen()).toBe(true);
    await escape();
    expect(isOpen()).toBe(true);
    await escape();
    expect(isOpen()).toBe(false);
  });

  it("两步是同一个窗口：换一步不换窗", async () => {
    await start();
    const panel = document.querySelector('[role="dialog"]');
    expect(onMembers()).toBe(false);
    await pickProject("eta");
    expect(onMembers()).toBe(true);
    const dialogs = document.querySelectorAll('[role="dialog"]');
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]).toBe(panel);
  });
});
