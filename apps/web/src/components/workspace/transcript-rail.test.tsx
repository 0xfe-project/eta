import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { act } from "react";
import { cleanup, mount } from "@/test-render";
import { TranscriptRail } from "./transcript-rail";

async function render(node: React.ReactNode) {
  return (await mount(node)).container;
}

afterEach(cleanup);

const entries = (count: number, prefix = "m") =>
  Array.from({ length: count }, (_, index) => ({
    id: `${prefix}${index}`,
    text: `第 ${index + 1} 条`,
  }));

/** The numbers drawn in the lane a screen reader calls `label`. */
const lane = (container: HTMLElement, label: string) => [
  ...container.querySelectorAll(`[aria-label="${label}"] button`),
];

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

  it("回复和提问是两条轨，各数各的", async () => {
    const jump = rstest.fn();
    const container = await render(
      <TranscriptRail
        replies={entries(12)}
        prompts={entries(6, "p")}
        activeId={undefined}
        onJump={jump}
      />,
    );
    const replies = lane(container, "智能体的回复");
    const prompts = lane(container, "你发的消息");
    expect(replies.length).toBeGreaterThan(0);
    expect(prompts.map((button) => button.textContent)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
    ]);
    // The prompt lane's "1" is the first prompt, not the first reply.
    await act(async () => (prompts[0] as HTMLButtonElement).click());
    expect(jump).toHaveBeenCalledWith("p0");
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
    const replies = entries(12);
    replies[3] = { id: "m3", text: `第 4 条\n${"很长的回复".repeat(20)}` };
    const container = await render(
      <TranscriptRail
        replies={replies}
        prompts={[]}
        activeId="m3"
        onJump={() => {}}
      />,
    );
    const current = container.querySelector('[aria-current="true"]')!;
    expect(current.textContent).toBe("4");
    const title = current.getAttribute("title")!;
    expect(title.startsWith("4 · 第 4 条 很长的回复")).toBe(true);
    expect(title).toHaveLength("4 · ".length + 44 + "…".length);
  });
});
