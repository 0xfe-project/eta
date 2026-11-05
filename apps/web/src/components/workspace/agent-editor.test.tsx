import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  rstest,
} from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { setWire } from "@/lib/wire";
import { agentView, machineView } from "@/test-product";
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

rstest.mock("./agent-identity", () => ({ AgentAvatar: () => <span /> }));
rstest.mock("sonner", () => ({
  toast: { success: () => {}, error: () => {} },
}));

let host: FakeHost;
const updates = () =>
  host.calls.filter((call) => call.action === "update").map((c) => c.args);

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);
const settle = () =>
  act(() => new Promise((resolve) => setTimeout(resolve, 20)));

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
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <AgentEditor />
      </QueryClientProvider>,
    ),
  );
  await act(async () =>
    useWorkspaceStore.getState().setAgentEditor({ open: true, agentId: "a1" }),
  );
  await settle();
});
afterEach(async () => {
  await act(async () =>
    useWorkspaceStore.getState().setAgentEditor({ open: false, agentId: null }),
  );
  await act(async () => root.render(null));
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
    await act(async () => root.render(null));
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
    await act(async () =>
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <AgentEditor />
        </QueryClientProvider>,
      ),
    );
    await settle();
  }

  const radio = (name: string) =>
    document.querySelector<HTMLInputElement>(
      `input[type="radio"][aria-label="${name}"]`,
    )!;
  const trigger = (id: string) =>
    document.getElementById(id) as HTMLButtonElement;

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
