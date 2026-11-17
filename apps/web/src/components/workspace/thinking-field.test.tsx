/**
 * The thinking-level field, in the agent editor and in the new-agent wizard (#623, #625): the
 * levels on offer are the chosen model's own, a change of model takes back a level the new one
 * does not take (and says so), a model whose levels are unknown keeps what was chosen, and a saved
 * level the model does not take is shown with a note rather than changed.
 */
import type { AgentView } from "@eta/client-contracts";
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
import { agentView } from "@/test-product";
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
        // Declares up to max, and can be told not to think.
        {
          id: "deep",
          name: "Deep",
          reasoning: true,
          thinkingMode: "both" as const,
          reasoningEfforts: [
            "low" as const,
            "high" as const,
            "xhigh" as const,
            "max" as const,
          ],
        },
        // Declares two levels.
        {
          id: "short",
          name: "Short",
          reasoning: true,
          reasoningEfforts: ["low" as const, "medium" as const],
        },
        // Declares nothing.
        { id: "plain", name: "Plain" },
      ],
    },
  ],
};

const runtimes = [
  {
    id: "codex",
    label: "Codex",
    status: "available",
    models: [
      {
        id: "astra",
        name: "Astra",
        default: true,
        efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      },
      {
        id: "sol",
        name: "Sol",
        default: false,
        efforts: ["low", "medium", "high"],
      },
    ],
  },
];

const api = rstest.hoisted(() => ({
  select: rstest.fn(),
  agents: [] as AgentView[],
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
/** What a select offers, by its options' words, and closes it again. */
const offered = async (id: string): Promise<string[]> => {
  await press(document.getElementById(id)!);
  const words = options().map((option) => option.textContent?.trim() ?? "");
  await act(async () => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
  await settle();
  return words;
};
const choose = async (id: string, text: string) => {
  await press(document.getElementById(id)!);
  await press(
    options().find((option) => option.textContent?.trim() === text) ??
      options().find((option) => option.textContent?.includes(text))!,
  );
};
const trigger = () => document.getElementById("agent-thinking")!.textContent;
const hint = () =>
  document.getElementById("agent-thinking-hint") as HTMLElement | null;
const button = (name: string) =>
  [
    ...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'),
  ].find((b) => b.textContent === name)!;

let host: FakeHost;
let saved: unknown[] = [];

async function openEditor(agent: AgentView | null) {
  saved = [];
  host = new FakeHost()
    .target("providers", { config: providers }, { eager: true })
    .target("personas", { cards: [] }, { eager: true })
    .target("agents", { list: agent === null ? [] : [agent] }, { eager: true })
    .plugins([
      { name: "providers", source: "bundled" },
      { name: "agents", source: "bundled" },
    ])
    .handle("agents.runtimes", () => ({ runtimes }))
    .handle("agents.update", (args) => {
      saved.push(args);
      return {};
    })
    .handle("agents.create", (args) => {
      saved.push(args);
      return { agent: agentView({ id: "new", name: "x" }) };
    })
    .install();
  host.hello();
  api.agents = agent === null ? [] : [agent];
  await mount(<AgentEditor />);
  await act(async () =>
    useWorkspaceStore
      .getState()
      .setAgentEditor({ open: true, agentId: agent?.id ?? null }),
  );
  await settle();
}

afterEach(async () => {
  await act(async () =>
    useWorkspaceStore.getState().setAgentEditor({ open: false, agentId: null }),
  );
  await cleanup();
  setWire(undefined);
});

describe("the thinking field in the agent editor", () => {
  const agent = (fields: Partial<AgentView>) =>
    agentView({ id: "a1", name: "审查", model: "c:deep", ...fields });

  it("offers the model's own levels, and the five when it declares none", async () => {
    await openEditor(agent({}));
    expect(await offered("agent-thinking")).toEqual([
      "跟随模型默认",
      "off",
      "low",
      "high",
      "xhigh",
      "max",
    ]);
    await choose("agent-model", "Short");
    expect(await offered("agent-thinking")).toEqual([
      "跟随模型默认",
      "low",
      "medium",
    ]);
    await choose("agent-model", "Plain");
    expect(await offered("agent-thinking")).toEqual([
      "跟随模型默认",
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
    expect(hint()).toBeNull();
  });

  it("takes a level back to the model's default when the new model does not take it, and says so", async () => {
    await openEditor(agent({}));
    await choose("agent-thinking", "xhigh");
    await choose("agent-model", "Short");
    expect(trigger()).toContain("跟随模型默认");
    expect(hint()?.textContent).toBe(
      "新模型不支持 xhigh，已改回跟随模型默认。",
    );
    expect(hint()?.className).toContain("text-state-warning");
    // Saved as the default: the user saw it before saving.
    await press(button("保存"));
    expect(saved[0]).toMatchObject({ model: "c:short", thinkingLevel: null });
  });

  it("keeps the level when the new model's levels are unknown, and says it is passed as chosen", async () => {
    await openEditor(agent({}));
    await choose("agent-thinking", "xhigh");
    await choose("agent-model", "Plain");
    expect(trigger()).toContain("xhigh");
    expect(hint()?.textContent).toBe(
      "暂时拿不到这个模型的能力，会按你选的原样传",
    );
    expect(hint()?.className).not.toContain("text-state-warning");
  });

  it("shows a saved level the model does not take, marked, and leaves it as it is", async () => {
    await openEditor(agent({ model: "c:short", thinkingLevel: "max" }));
    expect(trigger()).toContain("max");
    expect(hint()?.textContent).toBe("当前模型不支持，按模型默认运行");
    expect(hint()?.className).toContain("text-state-warning");
    // Not changed behind the user's back: still offered, still chosen.
    expect(await offered("agent-thinking")).toEqual([
      "跟随模型默认",
      "max",
      "low",
      "medium",
    ]);
    expect(trigger()).toContain("max");
  });

  it("offers `ultra` on an external model that declares it, and takes it back on one that does not", async () => {
    await openEditor(
      agent({ runtime: "codex", model: "codex:astra", thinkingLevel: null }),
    );
    expect(await offered("agent-thinking")).toEqual([
      "跟随模型默认",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
    await choose("agent-thinking", "ultra");
    expect(hint()).toBeNull();
    await choose("agent-model", "Sol");
    expect(trigger()).toContain("跟随模型默认");
    expect(hint()?.textContent).toBe(
      "新模型不支持 ultra，已改回跟随模型默认。",
    );
    // A new choice clears the note.
    await choose("agent-thinking", "high");
    expect(hint()).toBeNull();
  });
});

describe("the thinking field in the new-agent wizard", () => {
  beforeEach(async () => {
    await openEditor(null);
  });

  it("follows the model chosen on the first step", async () => {
    await choose("agent-model", "Deep");
    expect(await offered("agent-thinking")).toContain("max");
    await choose("agent-thinking", "max");
    await choose("agent-model", "Short");
    expect(trigger()).toContain("跟随模型默认");
    expect(hint()?.textContent).toBe("新模型不支持 max，已改回跟随模型默认。");
  });

  it("keeps the level on a model whose levels are unknown", async () => {
    await choose("agent-model", "Deep");
    await choose("agent-thinking", "xhigh");
    await choose("agent-model", "Plain");
    expect(trigger()).toContain("xhigh");
    expect(hint()?.textContent).toBe(
      "暂时拿不到这个模型的能力，会按你选的原样传",
    );
  });

  it("offers `ultra` on an external runtime's model that declares it", async () => {
    await choose("agent-runtime", "Codex");
    await choose("agent-model", "Astra");
    expect(await offered("agent-thinking")).toContain("ultra");
    await choose("agent-thinking", "ultra");
    await choose("agent-model", "Sol");
    expect(await offered("agent-thinking")).not.toContain("ultra");
    expect(hint()?.textContent).toBe(
      "新模型不支持 ultra，已改回跟随模型默认。",
    );
  });
});
