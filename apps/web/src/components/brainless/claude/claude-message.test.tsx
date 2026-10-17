import { afterEach, describe, expect, it } from "@rstest/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ClaudeMessage } from "./claude-message";

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

describe("谁说的话", () => {
  it("我说的话在右边，有底色，最多占八成宽", async () => {
    const container = await render(
      <ClaudeMessage role="user">look at this</ClaudeMessage>,
    );
    const row = container.firstElementChild!;
    expect(row.className).toContain("justify-end");
    const bubble = row.firstElementChild!;
    expect(bubble.className).toContain("max-w-[80%]");
    expect(bubble.className).toContain("bg-[var(--terminal-surface)]");
  });

  it("智能体说的话在左边，没有底色", async () => {
    const container = await render(
      <ClaudeMessage>here is the answer</ClaudeMessage>,
    );
    expect(container.firstElementChild!.className).not.toContain("justify-end");
    expect(container.innerHTML).not.toContain("terminal-surface");
  });

  it("群里有多个说话人时才署名", async () => {
    const named = await render(
      <ClaudeMessage author="乐子人">在</ClaudeMessage>,
    );
    expect(named.textContent).toContain("乐子人");
    const plain = await render(<ClaudeMessage>在</ClaudeMessage>);
    expect(plain.textContent).toBe("在");
  });
});
