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

const api = rstest.hoisted(() => ({ select: rstest.fn() }));
rstest.mock("./use-agents", () => ({
  useAgents: () => ({ agents: [], select: api.select }),
}));
rstest.mock("./agent-identity", () => ({ AgentAvatar: () => <span /> }));
rstest.mock("sonner", () => ({
  toast: { success: () => {}, error: () => {} },
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);
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
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <AgentEditor />
      </QueryClientProvider>,
    ),
  );
});
afterEach(async () => {
  await act(async () =>
    useWorkspaceStore.getState().setAgentEditor({ open: false, agentId: null }),
  );
  await act(async () => root.render(null));
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
      },
    ]);
    expect(api.select).toHaveBeenCalledWith("new");
    expect(dialog()).toBeNull();
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
      },
    ]);
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

  it("does not ask for a machine: a new agent follows the project", async () => {
    await open();
    expect(document.getElementById("agent-machine")).toBeNull();
    // The runtimes on offer are the host's own.
    expect(
      host.calls
        .filter((call) => call.action === "runtimes")
        .map((call) => call.args),
    ).toEqual([{}]);
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
