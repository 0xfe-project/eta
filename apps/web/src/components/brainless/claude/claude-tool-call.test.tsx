import { afterEach, describe, expect, it } from "@rstest/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ClaudeToolCall } from "./claude-tool-call";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const cleanup: (() => void)[] = [];
async function render(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  cleanup.push(() => {
    root.unmount();
    container.remove();
  });
  return container;
}

afterEach(async () => {
  await act(async () => cleanup.splice(0).forEach((dispose) => dispose()));
});

describe("工具卡", () => {
  it("收起时给工具名、一句摘要和状态，展开才给全文", async () => {
    const container = await render(
      <ClaudeToolCall
        tool="bash"
        arg="bun test --filter rail"
        result="completed"
        label="done"
        status="success"
      >
        全部通过
      </ClaudeToolCall>,
    );
    expect(container.querySelector("details")).not.toBeNull();
    expect(container.querySelector("details")!.open).toBe(false);
    expect(container.textContent).toContain("bash");
    expect(container.textContent).toContain("bun test --filter rail");
    expect(container.textContent).toContain("done");
    // The body exists but is behind the disclosure.
    expect(container.textContent).toContain("全部通过");
  });

  it("失败时徽标说的也是失败", async () => {
    const container = await render(
      <ClaudeToolCall tool="bash" result="failed" label="failed" status="error">
        exit 1
      </ClaudeToolCall>,
    );
    const badge = [...container.querySelectorAll("span")].find(
      (span) => span.textContent === "failed",
    )!;
    expect(badge).toBeDefined();
  });
});
