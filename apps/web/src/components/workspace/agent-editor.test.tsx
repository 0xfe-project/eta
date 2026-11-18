import type { AgentView, PluginView } from "@eta/client-contracts";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setWire } from "@/lib/wire";
import { agentView, machineView } from "@/test-product";
import { cleanup, flush, mount } from "@/test-render";
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

vi.mock("./agent-identity", () => ({ AgentAvatar: () => <span /> }));
vi.mock("sonner", () => ({
  toast: { success: () => {}, error: () => {} },
}));

let host: FakeHost;
const updates = () =>
  host.calls.filter((call) => call.action === "update").map((c) => c.args);

const settle = () => flush(20);

const buttons = () => [
  ...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'),
];
const tab = (label: string) =>
  buttons().find((b) => b.closest("nav") && b.textContent?.startsWith(label))!;
const current = () =>
  document.querySelector('[role="dialog"] nav [aria-current="page"]')
    ?.textContent ?? "";
const field = (id: string) =>
  document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null;
const type = async (id: string, value: string) => {
  const element = field(id)!;
  const setter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(element),
    "value",
  )!.set!;
  await act(async () => {
    setter.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const click = async (button: HTMLButtonElement) => {
  await act(async () => button.click());
  await settle();
};
const save = () => click(buttons().find((b) => b.textContent === "保存")!);
const dialogText = () =>
  document.querySelector('[role="dialog"]')?.textContent ?? "";

beforeEach(async () => {
  host = new FakeHost()
    .target("providers", { config: providers }, { eager: true })
    .target(
      "agents",
      {
        list: [
          agentView({
            id: "a1",
            name: "审查",
            instructions: "只看会出错的地方",
            model: "c:m1",
          }),
        ],
      },
      { eager: true },
    )
    .target(
      "personas",
      {
        cards: [
          { id: "terse", name: "简短", description: "话少", custom: false },
        ],
      },
      { eager: true },
    )
    .plugins([
      { name: "providers", source: "bundled" },
      { name: "agents", source: "bundled" },
    ])
    .handle("agents.update", () => ({}))
    .install();
  host.hello();
  await mount(<AgentEditor />);
  await act(async () =>
    useWorkspaceStore.getState().setAgentEditor({ open: true, agentId: "a1" }),
  );
  await settle();
});
afterEach(async () => {
  await act(async () =>
    useWorkspaceStore.getState().setAgentEditor({ open: false, agentId: null }),
  );
  await cleanup();
  setWire(undefined);
});

describe("editing an agent in tabs", () => {
  it("keeps edits across tabs and saves them together", async () => {
    expect(current()).toBe("常规");
    expect(field("agent-description")).toBeNull();
    await type("agent-name", "代码审查");

    await click(tab("指令"));
    expect(field("agent-name")).toBeNull();
    await type("agent-description", "只看 PR");
    await click(tab("常规"));
    expect(field("agent-name")!.value).toBe("代码审查");
    await click(tab("指令"));
    expect(field("agent-description")!.value).toBe("只看 PR");

    // Saved from any tab.
    await save();
    expect(updates()).toEqual([
      {
        agentId: "a1",
        name: "代码审查",
        instructions: "只看 PR",
        persona: "",
        runtime: "eta",
        model: "c:m1",
        thinkingLevel: null,
        machineId: null,
        plugins: [],
      },
    ]);
  });

  it("opens the tab of an error and marks it", async () => {
    await type("agent-name", " ");
    await click(tab("指令"));
    await type("agent-description", "改了");
    await save();

    expect(updates()).toEqual([]);
    expect(current()).toBe("常规（有错误）");
    expect(document.activeElement).toBe(field("agent-name"));
    expect(
      document.querySelector('[role="dialog"] [role="alert"]')?.textContent,
    ).toBe("请输入名称。");

    await type("agent-name", "审查 2");
    expect(current()).toBe("常规");
    await save();
    expect(updates()).toHaveLength(1);
  });

  it("saves the thinking level and the persona with the rest", async () => {
    const choose = async (id: string, text: string) => {
      await click(document.getElementById(id) as HTMLButtonElement);
      const option = [
        ...document.querySelectorAll<HTMLElement>('[role="option"]'),
      ].find((candidate) => candidate.textContent?.includes(text))!;
      await click(option as unknown as HTMLButtonElement);
    };
    await choose("agent-thinking", "high");
    await choose("agent-persona", "简短");
    await save();
    expect(updates()[0]).toMatchObject({
      agentId: "a1",
      thinkingLevel: "high",
      persona: "terse",
    });
  });

  it("shows the chosen persona in the trigger as soon as it is picked", async () => {
    // The click has to change what the trigger reads right away: the same tick, without
    // waiting for a save, a refetch or anything else re-rendering the tree.
    const trigger = () =>
      document.getElementById("agent-persona") as HTMLButtonElement;
    expect(trigger().textContent).toContain("项目默认");
    await click(trigger());
    const option = [
      ...document.querySelectorAll<HTMLElement>('[role="option"]'),
    ].find((candidate) => candidate.textContent?.includes("简短"))!;
    await click(option as unknown as HTMLButtonElement);
    expect(trigger().textContent).toContain("简短");
  });
});

describe("deleting an agent", () => {
  // The footer's own name for it: the button that opens the confirmation.
  const deleteButton = () =>
    buttons().find((button) => button.textContent === "删除智能体");
  const footer = () =>
    document.querySelector('[data-slot="dialog-footer"]') as HTMLElement;

  // A fresh list, and the editor opened on one of them.
  const open = async (agent: AgentView) => {
    await act(async () =>
      useWorkspaceStore
        .getState()
        .setAgentEditor({ open: false, agentId: null }),
    );
    host.set("agents", { list: [agent] });
    await settle();
    await act(async () =>
      useWorkspaceStore
        .getState()
        .setAgentEditor({ open: true, agentId: agent.id }),
    );
    await settle();
  };

  it("is not offered on the Captain's own settings", async () => {
    await open(
      agentView({
        id: "captain",
        name: "Captain",
        systemRole: "captain",
        model: "c:m1",
      }),
    );
    expect(dialogText()).toContain("Captain");
    // The host refuses to delete a Captain as an ordinary agent: the editor does not offer
    // it, and nothing is left behind to confirm it either.
    expect(deleteButton()).toBeUndefined();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    // With nothing on the left, the buttons it does have stay on the right.
    expect(footer().children).toHaveLength(1);
    expect(footer().className).toContain("sm:justify-end");
    expect(footer().className).not.toContain("sm:justify-between");
  });

  it("is still offered on an ordinary agent", async () => {
    await open(agentView({ id: "a2", name: "助手", model: "c:m1" }));
    expect(deleteButton()?.textContent).toBe("删除智能体");
    expect(footer().className).toContain("sm:justify-between");
  });
});

describe("picking a model", () => {
  it("shows the new model at once and saves it", async () => {
    const trigger = document.getElementById("agent-model")!;
    await click(trigger as HTMLButtonElement);
    const option = [
      ...document.querySelectorAll<HTMLElement>('[role="option"]'),
    ].find((candidate) => candidate.textContent?.includes("M2"))!;
    await click(option as unknown as HTMLButtonElement);
    // The reading of the trigger is the whole complaint: the pick has to be visible before
    // anything else happens, not after the next refetch.
    expect(trigger.textContent).toContain("M2");
    await save();
    expect(updates()[0]).toMatchObject({ agentId: "a1", model: "c:m2" });
  });
});

describe("an agent's model on eta's own loop", () => {
  const reopen = async (model: string | null) => {
    await act(async () =>
      useWorkspaceStore
        .getState()
        .setAgentEditor({ open: false, agentId: null }),
    );
    host.set("agents", {
      list: [agentView({ id: "a1", name: "审查", model })],
    });
    await settle();
    await act(async () =>
      useWorkspaceStore
        .getState()
        .setAgentEditor({ open: true, agentId: "a1" }),
    );
    await settle();
  };

  it("offers no default to fall back to, and will not save without a model", async () => {
    await reopen(null);
    const trigger = document.getElementById("agent-model")!;
    expect(trigger.textContent).toBe("选择模型");
    await click(trigger as HTMLButtonElement);
    const offered = [
      ...document.querySelectorAll<HTMLElement>('[role="option"]'),
    ].map((option) => option.textContent);
    expect(offered).toEqual(["M1", "M2"]);
    await act(async () =>
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    await settle();
    await type("agent-name", "审查二");
    await save();
    expect(dialogText()).toContain("请选择模型。");
    expect(updates()).toEqual([]);
  });

  it("says a model removed from the providers is no longer available, and swaps in none", async () => {
    await reopen("c:gone");
    expect(document.getElementById("agent-model")!.textContent).toBe(
      "c:gone（已不可用）",
    );
    expect(dialogText()).toContain("模型已不可用，请重新选择。");
  });
});

describe("an agent's persona and its runtime", () => {
  const persona = () =>
    document.getElementById("agent-persona") as HTMLButtonElement;
  const choose = async (id: string, text: string) => {
    await click(document.getElementById(id) as HTMLButtonElement);
    const option = [
      ...document.querySelectorAll<HTMLElement>('[role="option"]'),
    ].find((candidate) => candidate.textContent?.includes(text))!;
    await click(option as unknown as HTMLButtonElement);
  };

  beforeEach(async () => {
    await act(async () =>
      useWorkspaceStore
        .getState()
        .setAgentEditor({ open: false, agentId: null }),
    );
    host.handle("agents.runtimes", () => ({
      runtimes: [
        { id: "codex", label: "Codex", status: "available", models: [] },
      ],
    }));
    host.set("personas", {
      cards: [
        { id: "terse", name: "简短", description: "话少", custom: false },
        { id: "warm", name: "温和", description: "耐心", custom: false },
      ],
    });
    host.set("agents", {
      list: [
        agentView({ id: "a1", name: "审查", model: "c:m1", persona: "terse" }),
      ],
    });
    await settle();
    await act(async () =>
      useWorkspaceStore
        .getState()
        .setAgentEditor({ open: true, agentId: "a1" }),
    );
    await settle();
  });

  it("is choosable on eta's own runtime", async () => {
    expect(persona().textContent).toContain("简短");
    await choose("agent-persona", "温和");
    expect(persona().textContent).toContain("温和");
  });

  it("is not offered on an external runtime, and is still there on the way back", async () => {
    await choose("agent-runtime", "Codex");
    expect(persona()).toBeNull();
    expect(dialogText()).not.toContain("人格");

    await choose("agent-runtime", "eta 内置");
    expect(persona().textContent).toContain("简短");
    await choose("agent-persona", "温和");
    expect(persona().textContent).toContain("温和");

    // Saved as it is: the runtime does not clear it.
    await choose("agent-runtime", "Codex");
    await save();
    expect(updates()[0]).toMatchObject({ runtime: "codex", persona: "warm" });
  });
});

describe("an agent's machine and its runtimes", () => {
  // The host's own runtimes; another machine is asked over its link, and the daemon here is off.
  const runtimes = [
    {
      id: "claude",
      label: "Claude Code",
      status: "available",
      models: [
        { id: "opus", name: "Opus", default: false, efforts: [] },
        { id: "sonnet", name: "Sonnet", default: false, efforts: [] },
      ],
    },
  ];
  const asked = () =>
    host.calls
      .filter((call) => call.action === "runtimes")
      .map((call) => call.args);

  async function withMachines(
    machineId: string | null,
    answer: (args: { machineId?: string }) => unknown = (args) => {
      if (args.machineId === "mac") throw new Error("mac is not online");
      if (args.machineId === "gpu") return { runtimes: [] };
      return { runtimes };
    },
  ) {
    await cleanup();
    setWire(undefined);
    host = new FakeHost()
      .target("providers", { config: providers }, { eager: true })
      .target(
        "agents",
        {
          list: [
            agentView({
              id: "a1",
              name: "审查",
              runtime: "claude",
              model: "claude:opus",
              machineId,
            }),
          ],
        },
        { eager: true },
      )
      .target(
        "machines",
        {
          list: [
            machineView({ id: "main", name: "主机" }),
            machineView({
              id: "mac",
              name: "mac",
              kind: "daemon",
              status: "offline",
            }),
            machineView({
              id: "old",
              name: "old",
              kind: "daemon",
              status: "offline",
            }),
            machineView({ id: "gpu", name: "gpu-box", kind: "daemon" }),
          ],
        },
        { eager: true },
      )
      .target("personas", { cards: [] }, { eager: true })
      .plugins([
        { name: "providers", source: "bundled" },
        { name: "agents", source: "bundled" },
        { name: "machines", source: "bundled" },
      ])
      .handle("agents.runtimes", (args) =>
        answer(args as { machineId?: string }),
      )
      .handle("agents.update", () => ({}))
      .install();
    host.hello();
    await mount(<AgentEditor />);
    await settle();
  }

  const radio = (name: string) =>
    document.querySelector<HTMLInputElement>(
      `input[type="radio"][aria-label="${name}"]`,
    )!;
  const trigger = (id: string) =>
    document.getElementById(id) as HTMLButtonElement;

  it("says in a few words why a runtime cannot be picked, the probe's own words under details", async () => {
    const timeout =
      "Failed to list opencode models: opencode models --verbose timeout after 30000 ms";
    let opencode: Record<string, unknown> = {
      id: "opencode",
      label: "OpenCode",
      status: "error",
      detail: timeout,
      models: [],
    };
    await withMachines(null, (args) =>
      args.machineId === "gpu"
        ? { runtimes: [] }
        : {
            runtimes: [
              {
                id: "claude",
                label: "Claude Code",
                status: "unauthenticated",
                detail: "is not signed in",
                models: [],
              },
              opencode,
              {
                id: "pi",
                label: "Pi",
                status: "error",
                detail: "spawn pi ENOENT",
                models: [],
              },
            ],
          },
    );
    await click(trigger("agent-runtime"));
    const option = (label: string) =>
      [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
        (candidate) => candidate.textContent?.startsWith(label),
      )!.textContent;
    expect(option("OpenCode")).toBe("OpenCode（探测超时 30s）");
    expect(option("Pi")).toBe("Pi（探测失败）");
    expect(dialogText().includes(timeout)).toBe(true);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    await settle();
    // The agent is on Claude Code, which is not signed in: what to run, where it is chosen.
    expect(document.getElementById("agent-runtime-sign-in")?.textContent).toBe(
      "Claude Code 还没登录：在终端运行 claude 登录，再点重试。",
    );
    const details = document.querySelector("#agent-runtime ~ div details")!;
    expect(details.textContent).toContain(timeout);
    expect(details.textContent).toContain("spawn pi ENOENT");

    // A retry asks past the host's cache, and its answer is the list from then on.
    opencode = { ...opencode, status: "available", detail: undefined };
    await click(buttons().find((b) => b.textContent === "重试")!);
    expect(asked()).toContainEqual({ fresh: true });
    expect(
      document.querySelector("#agent-runtime ~ div details")!.textContent,
    ).not.toContain(timeout);
  });

  it("keeps the runtime in view and the model choosable when the machine cannot be asked", async () => {
    await withMachines("mac");
    expect(asked()).toContainEqual({ machineId: "mac" });
    // Not blank: the runtime it is on, unavailable for now, and why.
    expect(trigger("agent-runtime").textContent).toContain("claude（不可用）");
    expect(document.getElementById("agent-runtime-hint")?.textContent).toBe(
      "这台机器现在连不上，查不到它装了哪些运行方式。",
    );
    // Not stuck loading, and not called gone: nobody could say.
    expect(trigger("agent-model").disabled).toBe(false);
    expect(trigger("agent-model").textContent).toBe("claude:opus");
  });

  it("reads as being looked for while the machine is asked", async () => {
    await withMachines("mac", () => new Promise(() => {}));
    expect(radio("mac").checked).toBe(true);
    expect(trigger("agent-runtime").textContent).toContain("正在检测");
    expect(document.getElementById("agent-runtime-hint")).toBeNull();
  });

  const row = (name: string) => radio(name).closest("label")!.textContent;
  const pick = (name: string) =>
    click(radio(name) as unknown as HTMLButtonElement);

  it("asks the host once for the primary, named or not", async () => {
    await withMachines(null);
    expect(asked()).toEqual([{}, { machineId: "gpu" }]);
    await pick("主机（主机器）");
    expect(radio("主机（主机器）").checked).toBe(true);
    expect(asked()).toEqual([{}, { machineId: "gpu" }]);
    expect(trigger("agent-runtime").textContent).toBe("Claude Code");
  });

  it("names the primary among the machines, and keeps the model when the machine changes", async () => {
    await withMachines("main");
    expect(
      [...document.querySelectorAll('input[type="radio"]')].map((input) =>
        input.getAttribute("aria-label"),
      ),
    ).toEqual(["跟随项目", "主机（主机器）", "mac", "old", "gpu-box"]);
    await pick("跟随项目");
    expect(trigger("agent-model").textContent).toBe("Opus");
    await save();
    expect(updates()[0]).toMatchObject({
      machineId: null,
      runtime: "claude",
      model: "claude:opus",
    });
  });

  it("keeps an agent on its offline machine, and no other offline one can be picked", async () => {
    await withMachines("mac");
    expect(radio("mac").checked).toBe(true);
    expect(row("mac")).toContain("连不上，无法确认运行方式");
    expect(radio("old").disabled).toBe(true);

    // Trying another machine does not lose the way back.
    await pick("主机（主机器）");
    expect(radio("mac").disabled).toBe(false);
    await pick("mac");
    await type("agent-name", "改名");
    await save();
    expect(updates()[0]).toMatchObject({
      machineId: "mac",
      runtime: "claude",
      model: "claude:opus",
    });
  });

  it("says what is running on a machine as far as it can tell, and never that it is idle", async () => {
    await withMachines("main");
    expect(row("主机（主机器）")).toContain("在线");
    expect(row("主机（主机器）")).not.toContain("运行中");
    expect(row("主机（主机器）")).not.toContain("空闲");
    await act(async () =>
      host.set("agents", {
        list: [
          agentView({
            id: "a1",
            name: "审查",
            runtime: "claude",
            model: "claude:opus",
            machineId: "main",
            status: "working",
          }),
        ],
      }),
    );
    await settle();
    expect(row("主机（主机器）")).toContain("在线 · 1 个运行中");
  });

  it("does not move a saved agent off a runtime the machine lacks", async () => {
    await withMachines(null);
    await pick("gpu-box");
    expect(trigger("agent-runtime").textContent).toContain("claude（不可用）");
    expect(document.getElementById("agent-runtime-note")).toBeNull();
    await save();
    expect(updates()[0]).toMatchObject({
      machineId: "gpu",
      runtime: "claude",
      model: "claude:opus",
    });
  });
});

describe("the plugins tab", () => {
  const plugin = (fields: Partial<PluginView>): PluginView => ({
    name: "hello",
    version: "1.0.0",
    description: "",
    source: { kind: "local", path: "/p" },
    state: "ready",
    problem: null,
    reports: [],
    skills: [],
    servers: [
      {
        name: "hello",
        transport: "stdio",
        command: ["node", "server.mjs"],
        env: [],
        headers: [],
        problem: null,
      },
    ],
    requires: [],
    machines: [],
    fields: [],
    agents: [],
    ...fields,
  });

  async function openOn(
    agent: Partial<AgentView>,
    plugins: PluginView[],
  ): Promise<void> {
    await cleanup();
    host = new FakeHost()
      .target(
        "agents",
        { list: [agentView({ id: "a", ...agent })] },
        {
          eager: true,
        },
      )
      .target(
        "machines",
        { list: [machineView({ id: "m1" })] },
        {
          eager: true,
        },
      )
      .target("plugins", { list: plugins, audit: [] })
      .target("providers", { config: providers, catalog: [] })
      .handle("agents.update", () => ({}))
      .plugins([
        { name: "agents", source: "bundled" },
        { name: "plugins", source: "bundled" },
      ]);
    host.install();
    host.hello();
    await mount(<AgentEditor />);
    useWorkspaceStore.setState((state) => ({
      ...state,
      agentEditor: { open: true, agentId: "a" },
    }));
    await settle();
    await click(tab("插件"));
    await settle();
  }

  const box = (name: string) =>
    [...document.querySelectorAll('[role="dialog"] li')]
      .find((row) => row.textContent?.includes(name))
      ?.querySelector<HTMLButtonElement>('[role="checkbox"]');

  it("ticks one that can be enabled, and saves it with the rest", async () => {
    await openOn({}, [plugin({})]);
    await click(box("hello")!);
    await save();
    await settle();
    expect(updates().at(-1)).toMatchObject({ plugins: ["hello"] });
  });

  it("cannot tick one that needs configuring", async () => {
    await openOn({}, [plugin({ state: "needs_config" })]);
    expect(box("hello")?.hasAttribute("disabled")).toBe(true);
    expect(dialogText()).toContain("待配置");
  });

  it("says what it will run", async () => {
    await openOn({}, [plugin({})]);
    expect(dialogText()).toContain("node server.mjs");
  });

  it("keeps one that fell back ticked, says it is skipped, and lets it go", async () => {
    await openOn({ plugins: ["hello"], skippedPlugins: ["hello"] }, [
      plugin({ state: "needs_config" }),
    ]);
    expect(dialogText()).toContain("正在跳过它");
    expect(box("hello")?.hasAttribute("disabled")).toBe(false);
    await click(box("hello")!);
    await save();
    await settle();
    expect(updates().at(-1)).toMatchObject({ plugins: [] });
  });
});
