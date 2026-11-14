import type { ProjectView } from "@eta/client-contracts";
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
  stewardId: "a2",
});
const house = projectView({ id: "p2", name: "house", path: `${HOME}/house` });
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

let host: ReturnType<typeof productHost>;
async function start({
  projects = [eta, house] as ProjectView[],
  people = agents,
  machines = [primary],
  projectId = undefined as string | undefined,
} = {}) {
  host = productHost({ agents: people, projects, machines });
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
  host.handle("projects.directories", (raw) => {
    const { path = HOME } = raw as { path?: string };
    return {
      path,
      home: HOME,
      parent: "/home",
      entries:
        path === HOME
          ? [
              {
                name: "eta",
                hidden: false,
                git: true,
                projectId: "p1",
              },
              { name: "fresh", hidden: false, git: false, projectId: null },
            ]
          : [],
      truncated: false,
    };
  });
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
const rowOf = (name: string) =>
  [...document.querySelectorAll<HTMLElement>("ul button")].find((candidate) =>
    candidate.textContent?.startsWith(name),
  );
const pickProject = async (name: string) => {
  await click(rowOf(name));
  await flush();
};
/** The home's own rows come after the projects, which can have the same name. */
const walkInto = async (name: string) => {
  await click(
    [...document.querySelectorAll<HTMLElement>("ul button")]
      .filter((candidate) => candidate.textContent?.startsWith(name))
      .at(-1),
  );
  await flush();
};
const next = async () => {
  await click(labelled("下一步"));
  await flush();
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

async function press(element: Element, key: string) {
  await act(async () => {
    element.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  });
  await flush();
}

const escape = () => press(document.activeElement ?? body(), "Escape");

describe("第一步：目录", () => {
  it("点项目直接进第二步，点目录是走进去", async () => {
    await start();
    await walkInto("fresh");
    expect(onMembers()).toBe(false);
    await click(button(body(), "~"));
    await flush();
    await pickProject("house");
    expect(onMembers()).toBe(true);
  });

  it("下一步选定当前目录，还没读到就不能按", async () => {
    await start();
    // The listing of `fresh` is held until the test lets it through.
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    host.handle("projects.directories", async (raw) => {
      const { path } = raw as { path: string };
      await held;
      return { path, home: HOME, parent: HOME, entries: [], truncated: false };
    });
    await walkInto("fresh");
    expect(labelled("下一步")!.disabled).toBe(true);
    release();
    await flush(20);
    expect(labelled("下一步")!.disabled).toBe(false);
    await next();
    expect(onMembers()).toBe(true);
    expect(body().textContent).toContain("fresh");
    expect(body().textContent).toContain("~/fresh");
    expect(body().textContent).toContain("新项目");
  });

  it("已是项目的路径按项目处理，不重复添加", async () => {
    await start();
    await walkInto("eta");
    await next();
    expect(body().textContent).not.toContain("新项目");
    await begin();
    expect(calls()).toEqual([
      [
        "conversations.create",
        { projectId: "p1", agentIds: ["a2"], stewardId: "a2" },
      ],
    ]);
  });

  it("输入路径时不能下一步：选定的不会是框里写的", async () => {
    await start();
    await click(labelled("输入路径"));
    expect(labelled("下一步")!.disabled).toBe(true);
  });

  it("读不了的目录不能下一步", async () => {
    await start();
    host.handle("projects.directories", () => {
      throw new Error("nobody home");
    });
    await walkInto("fresh");
    expect(labelled("下一步")!.disabled).toBe(true);
  });

  it("归档的项目不在列表里，交给 host 找回来", async () => {
    await start({
      projects: [
        projectView({
          id: "p3",
          name: "fresh",
          path: `${HOME}/fresh`,
          archived: true,
        }),
      ],
    });
    await walkInto("fresh");
    await next();
    await begin();
    expect(calls()[0]).toEqual([
      "projects.create",
      { path: `${HOME}/fresh`, machineId: "m1", stewardId: "a1" },
    ]);
  });

  it("新目录开在所选的机器上", async () => {
    await start({
      machines: [
        primary,
        machineView({ id: "m2", name: "gpu", kind: "daemon", home: "/g" }),
      ],
    });
    await click(
      [
        ...document.querySelectorAll<HTMLButtonElement>(
          '[role="group"] button',
        ),
      ].find((candidate) => candidate.textContent === "gpu"),
    );
    await flush();
    await next();
    expect(body().textContent).toContain("gpu:");
    await begin();
    expect(calls()[0]![1]).toMatchObject({ machineId: "m2" });
  });

  it("只有一位智能体时按钮直接是开始", async () => {
    await start({ people: [agents[0]!] });
    expect(labelled("下一步")).toBeUndefined();
    await walkInto("fresh");
    await begin();
    expect(calls()).toEqual([
      [
        "projects.create",
        { path: `${HOME}/fresh`, machineId: "m1", stewardId: "a1" },
      ],
      [
        "conversations.create",
        { projectId: "made", agentIds: ["a1"], stewardId: "a1" },
      ],
    ]);
    expect(isOpen()).toBe(false);
  });

  it("只有一位智能体时失败也留在第二步，把原因说出来", async () => {
    await start({ people: [agents[0]!] });
    host.handle("projects.create", () => {
      throw new Error("no such directory");
    });
    await begin();
    expect(onMembers()).toBe(true);
    expect(body().textContent).toContain("no such directory");
    expect(isOpen()).toBe(true);
  });
});

describe("第二步：成员", () => {
  it("默认是项目的主理人", async () => {
    await start();
    await pickProject("eta");
    expect(ticked("装配检查")).toBe(true);
    expect(ticked("乐子人")).toBe(false);
    expect(steward()).toHaveLength(1);
    expect(steward()[0]).toContain("装配检查");
  });

  it("项目没有主理人时默认第一位智能体", async () => {
    await start();
    await pickProject("house");
    expect(steward()[0]).toContain("乐子人");
    await begin();
    expect(calls()).toEqual([
      [
        "conversations.create",
        { projectId: "p2", agentIds: ["a1"], stewardId: "a1" },
      ],
    ]);
  });

  it("一次写入多位成员，主理人跟选的走", async () => {
    await start();
    await pickProject("eta");
    await tick("文档员");
    await tick("乐子人");
    await click(stewardButton("文档员"));
    await begin();
    expect(calls()).toEqual([
      [
        "conversations.create",
        { projectId: "p1", agentIds: ["a2", "a3", "a1"], stewardId: "a3" },
      ],
    ]);
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/",
      search: { group: "c-new" },
    });
    expect(isOpen()).toBe(false);
  });

  it("没勾的行没有主理人按钮", async () => {
    await start();
    await pickProject("eta");
    expect(stewardButton("乐子人")).toBeNull();
    await tick("乐子人");
    expect(stewardButton("乐子人")!.textContent).toBe("设为主理人");
    expect(stewardButton("装配检查")!.textContent).toBe("主理人");
  });

  it("取消主理人后下一位已选成员接任，没人选时不能开始，再勾的第一位是主理人", async () => {
    await start();
    await pickProject("eta");
    await tick("文档员");
    await tick("乐子人");
    await tick("装配检查");
    expect(steward()[0]).toContain("文档员");
    await tick("乐子人");
    await tick("文档员");
    expect(steward()).toEqual([]);
    expect(labelled("开始")!.disabled).toBe(true);
    await tick("乐子人");
    expect(steward()[0]).toContain("乐子人");
    expect(labelled("开始")!.disabled).toBe(false);
  });

  it("动过的选择回到第一步改目录还在", async () => {
    await start();
    await pickProject("eta");
    await tick("文档员");
    await click(stewardButton("文档员"));
    await back();
    await pickProject("house");
    expect(ticked("装配检查")).toBe(true);
    expect(ticked("文档员")).toBe(true);
    expect(steward()[0]).toContain("文档员");
  });

  it("一个都没选时才重新套用默认", async () => {
    await start();
    await pickProject("house");
    await tick("乐子人");
    await back();
    await pickProject("eta");
    expect(steward()[0]).toContain("装配检查");
  });

  it("没动过时跟着目录换默认", async () => {
    await start();
    await pickProject("eta");
    await back();
    await pickProject("house");
    expect(steward()[0]).toContain("乐子人");
    expect(ticked("装配检查")).toBe(false);
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
  it("跳过第一步，上一步回到那个目录", async () => {
    await start({ projectId: "p2" });
    expect(onMembers()).toBe(true);
    await back();
    expect(onMembers()).toBe(false);
    const crumbs = [...document.querySelectorAll("nav button")];
    expect(crumbs.map((crumb) => crumb.textContent)).toEqual(["~", "house"]);
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
    await walkInto("fresh");
    await next();
    await click(labelled("取消"));
    await flush();
    expect(isOpen()).toBe(false);
    expect(calls()).toEqual([]);
    expect(
      useWorkspaceStore.getState().workspace.recentDirectories,
    ).toBeUndefined();
  });

  it("开始之后才记住用过的目录", async () => {
    await start();
    await pickProject("house");
    expect(
      useWorkspaceStore.getState().workspace.recentDirectories,
    ).toBeUndefined();
    await begin();
    expect(
      useWorkspaceStore.getState().workspace.recentDirectories?.m1,
    ).toEqual([`${HOME}/house`]);
  });

  it("输入路径时 Esc 先退出输入", async () => {
    await start();
    await click(labelled("输入路径"));
    await escape();
    expect(document.querySelector('input[aria-label="目录路径"]')).toBeNull();
    expect(isOpen()).toBe(true);
  });

  it("第二步 Esc 退回第一步，第一步才关闭", async () => {
    await start();
    await pickProject("eta");
    await escape();
    expect(onMembers()).toBe(false);
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
