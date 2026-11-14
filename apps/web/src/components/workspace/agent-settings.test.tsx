import { afterEach, describe, expect, it } from "@rstest/core";
import { setWire } from "@/lib/wire";
import { agentView } from "@/test-product";
import { cleanup, flush, mount } from "@/test-render";
import { FakeHost } from "@/test-wire";
import { AgentSettings } from "./agent-settings";

// The agents list in settings checks each agent's model against eta's provider catalog. Only an
// agent on eta itself is checked: an external runtime's model is that runtime's own name for it.

const providers = {
  revision: "r1",
  providers: [
    {
      id: "c",
      name: "C",
      kind: "openai-compatible" as const,
      baseUrl: "http://127.0.0.1:1/v1",
      hasApiKey: true,
      models: [{ id: "m1", name: "M1" }],
    },
  ],
};

afterEach(async () => {
  await cleanup();
  setWire(undefined);
});

async function render() {
  const host = new FakeHost()
    .target("providers", { config: providers }, { eager: true })
    .target(
      "agents",
      {
        list: [
          agentView({ id: "a1", name: "审查", model: "c:m1" }),
          agentView({ id: "a2", name: "旧模型", model: "c:gone" }),
          agentView({
            id: "a3",
            name: "Opus",
            runtime: "claude",
            model: "claude:opus",
          }),
          agentView({ id: "a4", name: "Codex", runtime: "codex", model: null }),
          agentView({ id: "cap", name: "Captain", systemRole: "captain" }),
        ],
      },
      { eager: true },
    )
    .plugins([
      { name: "providers", source: "bundled" },
      { name: "agents", source: "bundled" },
    ]);
  host.install();
  host.hello();
  const { container } = await mount(<AgentSettings />);
  await flush(20);
  return container;
}

/** The row of the agent named `name`. */
function row(container: HTMLElement, name: string) {
  const found = container
    .querySelector(`button[aria-label="编辑 ${name}"]`)
    ?.closest("li");
  if (!found) throw new Error(`no row for ${name}`);
  return found;
}

describe("AgentSettings", () => {
  it("warns about an eta agent's missing model, and not about a runtime's own", async () => {
    const container = await render();
    expect(row(container, "审查").textContent).toContain("M1");
    expect(row(container, "审查").textContent).not.toContain("已不可用");
    const gone = row(container, "旧模型");
    // Said in full on the row: what is wrong and what to do, never another model in its place.
    expect(gone.textContent).toContain("c:gone 已不可用，请重新选择模型。");
    const opus = row(container, "Opus");
    expect(opus.textContent).toContain("claude:opus");
    expect(opus.textContent).not.toContain("已不可用");
    const codex = row(container, "Codex");
    expect(codex.textContent).toContain("运行时默认模型");
    expect(codex.textContent).not.toContain("未选择模型");
    expect(codex.textContent).not.toContain("已不可用");
  });

  it("leaves Captain out of the list and out of the count", async () => {
    const container = await render();
    const names = [
      ...container.querySelectorAll('li button[aria-label^="编辑 "]'),
    ].map((edit) => edit.getAttribute("aria-label")?.replace(/^编辑 /, ""));
    expect(names).toEqual(["审查", "旧模型", "Opus", "Codex"]);
    expect(container.querySelector("h2")!.textContent).toContain("4");
  });
});
