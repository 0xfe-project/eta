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
    // Class names are eta-old's: `.message.user` right-aligns, `.message-content` is the box that
    // carries the 72% width and the background (graphite.css, ported into styles.css).
    const row = container.firstElementChild!;
    expect(row.className).toContain("message");
    expect(row.className).toContain("user");
    expect(row.firstElementChild!.className).toContain("message-content");
  });

  it("智能体说的话在左边，没有底色", async () => {
    const container = await render(
      <ClaudeMessage>here is the answer</ClaudeMessage>,
    );
    expect(container.firstElementChild!.className).not.toContain("justify-end");
    expect(container.firstElementChild!.className).toContain("assistant");
    expect(container.firstElementChild!.className).not.toContain("user");
  });

  it("脚下那行小字是可选的", async () => {
    const withFooter = await render(
      <ClaudeMessage footer="18:34">在</ClaudeMessage>,
    );
    expect(withFooter.querySelector(".message-footer")?.textContent).toBe(
      "18:34",
    );
    const plain = await render(<ClaudeMessage>在</ClaudeMessage>);
    expect(plain.querySelector(".message-footer")).toBeNull();
  });
});
