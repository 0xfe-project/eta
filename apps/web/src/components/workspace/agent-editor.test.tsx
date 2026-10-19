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
import { AgentEditor } from "./agent-editor";
import { useWorkspaceStore } from "./workspace-store";

const api = rstest.hoisted(() => ({ update: rstest.fn() }));
const agent = rstest.hoisted(() => ({
  id: "a1",
  name: "审查",
  description: "只看会出错的地方",
  model: "m1",
  bundles: null,
  build_error: "",
  status: "idle",
}));
rstest.mock("@/queries/chat", () => ({
  useBundles: () => ({
    data: [{ name: "memory", description: "记忆", builtin: true }],
  }),
  useCreateAgent: () => ({ mutate: () => {} }),
  useDeleteAgent: () => ({ mutate: () => {} }),
  useUpdateAgent: () => ({ mutate: api.update, isPending: false }),
}));
rstest.mock("@/queries/llm", () => ({
  useModels: () => ({
    data: [
      {
        id: "m1",
        display_name: "M1",
        connector: "c",
        status: "available",
        available: true,
      },
      {
        id: "m2",
        display_name: "M2",
        connector: "c",
        status: "available",
        available: true,
      },
    ],
  }),
  useConnectors: () => ({ data: [{ id: "c", display_name: "C" }] }),
  useAgentUsage: () => ({ isPending: true }),
}));
rstest.mock("./use-agents", () => ({
  useAgents: () => ({ agents: [agent] }),
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
  api.update.mockReset();
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
});

describe("editing an agent in tabs", () => {
  it("keeps edits across tabs and saves them together", async () => {
    expect(current()).toBe("常规");
    expect(field("agent-description")).toBeNull();
    await type("agent-name", "代码审查");

    await click(tab("指令"));
    expect(field("agent-name")).toBeNull();
    await type("agent-description", "只看 PR");
    await click(tab("环境"));
    await click(tab("常规"));
    expect(field("agent-name")!.value).toBe("代码审查");
    await click(tab("指令"));
    expect(field("agent-description")!.value).toBe("只看 PR");

    // Saved from any tab.
    await save();
    expect(api.update).toHaveBeenCalledTimes(1);
    expect(api.update.mock.calls[0][0]).toEqual({
      id: "a1",
      name: "代码审查",
      description: "只看 PR",
      persona: "",
      model: "m1",
    });
  });

  it("opens the tab of an error and marks it", async () => {
    await type("agent-name", " ");
    await click(tab("指令"));
    await type("agent-description", "改了");
    await save();

    expect(api.update).not.toHaveBeenCalled();
    expect(current()).toBe("常规（有错误）");
    expect(document.activeElement).toBe(field("agent-name"));
    expect(
      document.querySelector('[role="dialog"] [role="alert"]')?.textContent,
    ).toBe("请输入名称。");

    await type("agent-name", "审查 2");
    expect(current()).toBe("常规");
    await save();
    expect(api.update).toHaveBeenCalledTimes(1);
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
    expect(api.update.mock.calls[0][0]).toMatchObject({
      id: "a1",
      model: "m2",
    });
  });
});
