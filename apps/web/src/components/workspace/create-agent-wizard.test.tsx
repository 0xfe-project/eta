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
import { agentView, machineView } from "@/test-product";
import { cleanup, mount } from "@/test-render";
import { FakeHost } from "@/test-wire";
import { AgentEditor } from "./agent-editor";
import { useWorkspaceStore } from "./workspace-store";

const providers = {
  revision: "r1",
  providers: [
    {
      id: "c",
      name: "C",
      kind: "openai-compatible" as const,
      baseUrl: "http://127.0.0.1:1/v1",
      hasApiKey: true,
      models: [
        { id: "m1", name: "M1" },
        { id: "m2", name: "M2" },
      ],
    },
  ],
};

const api = rstest.hoisted(() => ({
  select: rstest.fn(),
  agents: [] as { id: string; name: string }[],
}));
rstest.mock("./use-agents", () => ({
  useAgents: () => ({ agents: api.agents, select: api.select }),
}));
rstest.mock("./agent-identity", () => ({ AgentAvatar: () => <span /> }));
rstest.mock("sonner", () => ({
  toast: { success: () => {}, error: () => {} },
}));

const settle = () =>
  act(() => new Promise((resolve) => setTimeout(resolve, 20)));

const open = async () => {
  await act(async () =>
    useWorkspaceStore.getState().setAgentEditor({ open: true, agentId: null }),
  );
  await settle();
};
const dialog = () => document.querySelector('[role="dialog"]');
const step = () =>
  document.querySelector('[aria-current="step"]')?.textContent ?? "";
const button = (name: string) =>
  [
    ...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'),
  ].find((b) => b.textContent === name)!;
const field = (id: string) =>
  document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement;
const type = async (id: string, value: string) => {
  const element = field(id);
  const setter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(element),
    "value",
  )!.set!;
  await act(async () => {
    setter.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const click = async (name: string, detail = 1) => {
  await act(async () => {
    button(name).dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, detail }),
    );
  });
  await settle();
};
const alerts = () =>
  [...document.querySelectorAll('[role="dialog"] [role="alert"]')].map(
    (alert) => alert.textContent,
  );

// The external runtimes the host reports: one ready, one not on the machine.
const runtimes = [
  {
    id: "claude",
    label: "Claude Code",
    status: "available",
    models: [
      {
        id: "sonnet",
        name: "Sonnet",
        default: false,
        efforts: ["low", "high"],
      },
      { id: "opus", name: "Opus", default: false, efforts: ["low", "high"] },
    ],
  },
  { id: "codex", label: "Codex", status: "missing", models: [] },
];
const press = async (element: HTMLElement) => {
  await act(async () => {
    element.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }),
    );
  });
  await settle();
};
const options = () => [
  ...document.querySelectorAll<HTMLElement>('[role="option"]'),
];
const choose = async (id: string, text: string) => {
  await press(document.getElementById(id)!);
  await press(options().find((option) => option.textContent?.includes(text))!);
};

// The agents.create calls the page made, and how the host answers the next one.
let host: FakeHost;
let created: unknown[] = [];
let answer: (args: unknown) => Promise<unknown>;
const ok = async (args: unknown) => ({
  agent: agentView({ id: "new", name: (args as { name: string }).name }),
});

beforeEach(async () => {
  created = [];
  answer = ok;
  host = new FakeHost()
    .target("providers", { config: providers }, { eager: true })
    .target("personas", { cards: [] }, { eager: true })
    // More than one machine: the editor would offer to pin an agent to one.
    .target(
      "machines",
      {
        list: [
          machineView({ id: "main", name: "主机" }),
          machineView({ id: "mac", name: "mac", kind: "daemon" }),
        ],
      },
      { eager: true },
    )
    .plugins([
      { name: "providers", source: "bundled" },
      { name: "machines", source: "bundled" },
    ])
    .handle("agents.create", (args) => {
      created.push(args);
      return answer(args);
    })
    .handle("agents.runtimes", () => ({ runtimes }))
    .install();
  host.hello();
  api.select.mockReset();
  api.agents = [];
  await mount(<AgentEditor />);
});
afterEach(async () => {
  await act(async () =>
    useWorkspaceStore.getState().setAgentEditor({ open: false, agentId: null }),
  );
  await cleanup();
  setWire(undefined);
});

describe("creating an agent step by step", () => {
  it("checks each step, keeps input going back, creates only at the end", async () => {
    await open();
    expect(step()).toContain("名称与模型");
    expect(document.activeElement).toBe(field("agent-name"));

    await click("下一步");
    expect(step()).toContain("名称与模型");
    expect(alerts()).toContain("请输入名称。");

    await type("agent-name", "  审查  ");
    await click("下一步");
    expect(step()).toContain("指令");
    expect(document.activeElement).toBe(field("agent-description"));
    await type("agent-description", "只看会出错的地方");

    await click("上一步");
    expect(field("agent-name").value).toBe("  审查  ");
    await click("下一步");
    expect(field("agent-description").value).toBe("只看会出错的地方");
    expect(created).toEqual([]);

    await click("创建");
    // The last used or first usable model; no thinking level means the model's own.
    expect(created).toEqual([
      {
        name: "审查",
        instructions: "只看会出错的地方",
        persona: "",
        runtime: "eta",
        model: "c:m1",
        thinkingLevel: null,
        machineId: null,
        plugins: [],
      },
    ]);
    expect(api.select).toHaveBeenCalledWith("new");
    expect(dialog()).toBeNull();
  });

  it("stops at the name when another agent already answers to it", async () => {
    api.agents = [{ id: "a1", name: "审查" }];
    await open();
    await type("agent-name", " 审查 ");
    await click("下一步");
    // Said where the name is typed, before anything is sent: the host refuses it too.
    expect(step()).toContain("名称与模型");
    expect(alerts()).toContain("已有名为「审查」的智能体。");
    expect(created).toEqual([]);
    await type("agent-name", "审查二");
    await click("下一步");
    expect(step()).toContain("指令");
  });

  it("creates an agent on an external runtime, with one of its own models", async () => {
    await open();
    await type("agent-name", "Claude");
    await press(document.getElementById("agent-runtime")!);
    // A runtime the machine does not have is listed, and cannot be picked.
    const codex = options().find((option) =>
      option.textContent?.includes("Codex"),
    )!;
    expect(codex.textContent).toContain("未安装");
    expect(codex.getAttribute("aria-disabled")).toBe("true");
    await press(
      options().find((option) => option.textContent?.includes("Claude Code"))!,
    );
    // Its own default needs no choice; its models are the runtime's.
    expect(document.getElementById("agent-model")!.textContent).toContain(
      "运行时默认模型",
    );
    await choose("agent-model", "Sonnet");
    await click("下一步");
    await click("创建");
    expect(created).toEqual([
      {
        name: "Claude",
        instructions: "",
        persona: "",
        runtime: "claude",
        model: "claude:sonnet",
        thinkingLevel: null,
        machineId: null,
        plugins: [],
      },
    ]);
  });

  it("starts on the last used model", async () => {
    await act(async () =>
      useWorkspaceStore
        .getState()
        .setWorkspace((state) => ({ ...state, lastModel: "c:m2" })),
    );
    await open();
    await type("agent-name", "审查");
    await click("下一步");
    await click("创建");
    expect(created).toMatchObject([{ runtime: "eta", model: "c:m2" }]);
    await act(async () =>
      useWorkspaceStore
        .getState()
        .setWorkspace((state) => ({ ...state, lastModel: undefined })),
    );
  });

  it("will not create an agent on eta's own loop without a model, even with none to choose", async () => {
    host.set("providers", { config: { revision: "r2", providers: [] } });
    await open();
    await type("agent-name", "审查");
    await click("下一步");
    expect(step()).toContain("名称与模型");
    // Said, with the way to get a model.
    expect(alerts()).toEqual(["请选择模型。前往模型服务"]);
    expect(created).toEqual([]);
  });

  it("lets an agent on an external runtime run its own default", async () => {
    await open();
    await type("agent-name", "Claude");
    await press(document.getElementById("agent-runtime")!);
    await press(
      options().find((option) => option.textContent?.includes("Claude Code"))!,
    );
    await click("下一步");
    await click("创建");
    expect(created).toMatchObject([{ runtime: "claude", model: null }]);
  });

  it("keeps everything after a failure and creates once on retry", async () => {
    let finish!: (agent: unknown) => void;
    answer = async () => {
      throw new Error("宿主暂时不可用。");
    };
    await open();
    await type("agent-name", "审查");
    await click("下一步");
    await click("创建");
    expect(alerts()).toContain("创建失败：宿主暂时不可用。");
    expect(dialog()).not.toBeNull();

    await click("上一步");
    expect(field("agent-name").value).toBe("审查");
    await click("下一步");
    answer = () => new Promise((resolve) => (finish = resolve));
    await click("重试创建");
    expect(button("正在创建…").disabled).toBe(true);
    // Enter again while it is on its way.
    await act(async () =>
      document
        .querySelector('[role="dialog"] form')!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    await settle();
    expect(created).toHaveLength(2);
    await act(async () =>
      finish({ agent: agentView({ id: "new", name: "审查" }) }),
    );
    await settle();
    expect(dialog()).toBeNull();
  });

  it("ignores the second click of a double click on 下一步", async () => {
    await open();
    await type("agent-name", "审查");
    await click("下一步");
    // It lands on 创建, which took 下一步's place.
    await click("创建", 2);
    expect(created).toEqual([]);
  });

  it("starts over when cancelled and opened again", async () => {
    await open();
    await type("agent-name", "半成品");
    await click("下一步");
    await click("取消");
    expect(dialog()).toBeNull();

    await open();
    expect(step()).toContain("名称与模型");
    expect(field("agent-name").value).toBe("");
  });
});

describe("choosing where a new agent runs", () => {
  const claude = runtimes[0]!;
  const opencode = {
    id: "opencode",
    label: "OpenCode",
    status: "available",
    models: [{ id: "big", name: "Big", default: false, efforts: [] }],
  };
  const fleet = [
    machineView({ id: "main", name: "主机" }),
    machineView({ id: "gpu", name: "gpu-box", kind: "daemon" }),
    machineView({
      id: "mac",
      name: "mac",
      kind: "daemon",
      status: "offline",
    }),
  ];
  // The primary has Claude Code, gpu-box has OpenCode and a Claude Code of fewer models. A host
  // names every runtime it knows and says which ones are not there.
  const onEach = (args: { machineId?: string }) =>
    args.machineId === "gpu"
      ? {
          runtimes: [
            {
              ...claude,
              models: claude.models.filter((model) => model.id === "opus"),
            },
            opencode,
          ],
        }
      : { runtimes: [...runtimes, { ...opencode, status: "missing" }] };

  async function withMachines(
    list = fleet,
    answer: (args: { machineId?: string }) => unknown = onEach,
  ) {
    await cleanup();
    setWire(undefined);
    host = new FakeHost()
      .target("providers", { config: providers }, { eager: true })
      .target("personas", { cards: [] }, { eager: true })
      .target("machines", { list }, { eager: true })
      .plugins([
        { name: "providers", source: "bundled" },
        { name: "machines", source: "bundled" },
      ])
      .handle("agents.create", (args) => {
        created.push(args);
        return ok(args);
      })
      .handle("agents.runtimes", (args) =>
        answer(args as { machineId?: string }),
      )
      .install();
    host.hello();
    await mount(<AgentEditor />);
    await open();
  }

  const asked = () =>
    host.calls
      .filter((call) => call.action === "runtimes")
      .map((call) => call.args);
  const radio = (name: string) =>
    document.querySelector<HTMLInputElement>(
      `input[type="radio"][aria-label="${name}"]`,
    )!;
  const row = (name: string) => radio(name).closest("label")!.textContent;
  const trigger = (id: string) => document.getElementById(id)!;
  const note = () => document.getElementById("agent-runtime-note")?.textContent;

  it("lists the machines with what each runs, and follows the project unless told otherwise", async () => {
    await withMachines();
    expect(radio("跟随项目").checked).toBe(true);
    expect(row("跟随项目")).toContain("在项目所在的机器上运行");
    expect(dialog()!.textContent).toContain("运行方式先按主机器列出");
    expect(row("主机（主机器）")).toContain("在线");
    expect(row("主机（主机器）")).toContain("eta 内置 · Claude Code");
    // A runtime the machine lacks is not one it runs.
    expect(row("主机（主机器）")).not.toContain("Codex");
    expect(row("gpu-box")).toContain("eta 内置 · Claude Code · OpenCode");
    // The offline one is shown and not asked: there is nothing to reach.
    expect(row("mac")).toContain("离线");
    expect(row("mac")).toContain("连不上，无法确认运行方式");
    expect(radio("mac").disabled).toBe(true);
    expect(asked()).toEqual([{}, { machineId: "gpu" }]);

    await press(radio("gpu-box"));
    expect(dialog()!.textContent).not.toContain("运行方式先按主机器列出");

    await press(radio("跟随项目"));
    await type("agent-name", "审查");
    await click("下一步");
    await click("创建");
    expect(created).toMatchObject([{ machineId: null, runtime: "eta" }]);
  });

  it("does not show a machine still being asked as having nothing, and keeps one that fails choosable", async () => {
    let fail!: (reason: Error) => void;
    await withMachines(fleet, (args) =>
      args.machineId === "gpu"
        ? new Promise((_, reject) => (fail = reject))
        : { runtimes },
    );
    expect(
      radio("gpu-box")
        .closest("label")!
        .querySelector('[data-slot="skeleton"]'),
    ).not.toBeNull();
    expect(radio("gpu-box").disabled).toBe(false);
    // The others do not wait for it.
    expect(row("主机（主机器）")).toContain("Claude Code");

    await act(async () => fail(new Error("timed out")));
    await settle();
    expect(row("gpu-box")).toContain("无法确认运行方式");
    expect(radio("gpu-box").disabled).toBe(false);
  });

  it("is not there with one machine, and the agent follows the project", async () => {
    await withMachines([machineView({ id: "main", name: "主机" })]);
    expect(document.querySelector('[role="radiogroup"]')).toBeNull();
    expect(asked()).toEqual([{}]);
    await type("agent-name", "审查");
    await click("下一步");
    await click("创建");
    expect(created).toMatchObject([{ machineId: null }]);
  });

  it("offers a runtime only the chosen machine has, and creates the agent there", async () => {
    await withMachines();
    await press(trigger("agent-runtime"));
    expect(
      options()
        .find((option) => option.textContent?.includes("OpenCode"))
        ?.getAttribute("aria-disabled"),
    ).toBe("true");
    await act(async () =>
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })),
    );
    await press(radio("gpu-box"));
    await choose("agent-runtime", "OpenCode");
    await choose("agent-model", "Big");
    await type("agent-name", "训练");
    await click("下一步");
    await click("创建");
    expect(created).toMatchObject([
      { machineId: "gpu", runtime: "opencode", model: "opencode:big" },
    ]);
  });

  it("moves to a runtime the new machine has, says so, and picks the model again", async () => {
    await withMachines();
    await press(radio("gpu-box"));
    await choose("agent-runtime", "OpenCode");
    await choose("agent-model", "Big");

    await press(radio("主机（主机器）"));
    expect(trigger("agent-runtime").textContent).toBe("eta 内置");
    expect(note()).toBe("主机 上没有 OpenCode，已换成 eta 内置");
    // eta's first usable model, as for any new agent.
    expect(trigger("agent-model").textContent).toBe("M1");

    await press(radio("gpu-box"));
    expect(note()).toBeUndefined();
    await choose("agent-runtime", "OpenCode");
    await press(radio("跟随项目"));
    expect(note()).toBe("主机器 上没有 OpenCode，已换成 eta 内置");
    await choose("agent-runtime", "Claude Code");
    expect(note()).toBeUndefined();
  });

  it("does not carry a runtime to a machine that cannot vouch for it", async () => {
    await withMachines(fleet, (args) => {
      if (args.machineId === "gpu") throw new Error("timed out");
      return { runtimes };
    });
    await choose("agent-runtime", "Claude Code");
    await press(radio("gpu-box"));
    expect(trigger("agent-runtime").textContent).toBe("eta 内置");
    expect(note()).toBe("无法确认 gpu-box 有哪些运行方式，已换成 eta 内置");
  });

  it("keeps the runtime and only lets go of a model the new machine lacks", async () => {
    await withMachines();
    await choose("agent-runtime", "Claude Code");
    await choose("agent-model", "Opus");
    await press(radio("gpu-box"));
    expect(trigger("agent-model").textContent).toBe("Opus");

    await press(radio("主机（主机器）"));
    await choose("agent-model", "Sonnet");
    await press(radio("gpu-box"));
    expect(trigger("agent-runtime").textContent).toBe("Claude Code");
    expect(trigger("agent-model").textContent).toBe("运行时默认模型");
    expect(note()).toBeUndefined();
  });

  it("waits for the machine's answer before moving on with an external runtime", async () => {
    let answerGpu!: (result: unknown) => void;
    await withMachines(fleet, (args) =>
      args.machineId === "gpu"
        ? new Promise((resolve) => (answerGpu = resolve))
        : { runtimes },
    );
    await type("agent-name", "审查");
    await choose("agent-runtime", "Claude Code");
    await press(radio("gpu-box"));
    expect(button("下一步").disabled).toBe(true);
    // Enter does what the button does.
    await act(async () =>
      document
        .querySelector('[role="dialog"] form')!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    await settle();
    expect(step()).toContain("名称与模型");

    await act(async () =>
      answerGpu({
        runtimes: [{ ...claude, status: "missing", models: [] }, opencode],
      }),
    );
    await settle();
    expect(note()).toBe("gpu-box 上没有 Claude Code，已换成 eta 内置");
    expect(button("下一步").disabled).toBe(false);
  });

  it("does not pin to a machine that went offline after it was chosen", async () => {
    await withMachines();
    await press(radio("gpu-box"));
    await type("agent-name", "审查");
    await act(async () =>
      host.set("machines", {
        list: fleet.map((machine) =>
          machine.id === "gpu" ? { ...machine, status: "offline" } : machine,
        ),
      }),
    );
    await settle();
    await click("下一步");
    expect(step()).toContain("名称与模型");
    expect(alerts()).toContain("gpu-box 已经离线，请换一台机器。");

    await press(radio("跟随项目"));
    expect(alerts()).toEqual([]);
    await click("下一步");
    expect(step()).toContain("指令");
  });
});
