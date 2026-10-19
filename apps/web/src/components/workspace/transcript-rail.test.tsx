import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { TranscriptRail } from "./transcript-rail";

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

const entries = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: `m${index}`,
    text: `第 ${index + 1} 条`,
  }));

describe("右边缘的轨", () => {
  it("只有一条消息时不画", async () => {
    const container = await render(
      <TranscriptRail
        replies={entries(1)}
        prompts={[]}
        activeId={undefined}
        onJump={() => {}}
      />,
    );
    expect(container.textContent).toBe("");
  });

  it("回复是方块、提问是圆点，两条轨分开", async () => {
    const container = await render(
      <TranscriptRail
        replies={entries(12)}
        prompts={entries(6)}
        activeId={undefined}
        onJump={() => {}}
      />,
    );
    const lanes = container.querySelectorAll("[aria-label]");
    expect(lanes).toHaveLength(2);
    expect(container.textContent).toContain("1");
    // The prompt lane's numbers are round; the reply lane's are not.
    expect(container.innerHTML).toContain("rounded-full");
  });

  it("点一个编号就跳到那条消息", async () => {
    const jump = rstest.fn();
    const container = await render(
      <TranscriptRail
        replies={entries(12)}
        prompts={[]}
        activeId="m0"
        onJump={jump}
      />,
    );
    const buttons = [...container.querySelectorAll("button")];
    const target = buttons.find((button) => button.textContent === "12")!;
    await act(async () => target.click());
    expect(jump).toHaveBeenCalledWith("m11");
  });

  it("正在看的那条高亮，并带一句 44 字以内的提示", async () => {
    const container = await render(
      <TranscriptRail
        replies={entries(12)}
        prompts={[]}
        activeId="m3"
        onJump={() => {}}
      />,
    );
    const current = container.querySelector('[aria-current="true"]')!;
    expect(current.textContent).toBe("4");
    expect(current.getAttribute("title")).toBe("4 · 第 4 条");
  });
});
