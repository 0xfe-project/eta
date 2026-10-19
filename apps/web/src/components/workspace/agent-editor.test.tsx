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
import { agentView } from "@/test-product";
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
        model: "c:m1",
        thinkingLevel: null,
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

  it("has no bundles to choose: the host has none", async () => {
    expect(
      buttons().some((b) => b.closest("nav") && b.textContent === "环境"),
    ).toBe(false);
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
