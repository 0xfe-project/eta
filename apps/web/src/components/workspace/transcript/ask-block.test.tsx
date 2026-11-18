import type { Question } from "@/queries/questions";
import { afterEach, describe, expect, it, vi } from "vitest";
import { button, cleanup, click, mount } from "@/test-render";
import { AskBlock } from "./ask-block";

afterEach(cleanup);

const question: Question = {
  id: "question-1",
  conversationId: "conversation-1",
  agentId: "agent-1",
  prompt: "Pick one",
  options: ["A", "B", "C"],
  multi: false,
};

describe("AskBlock", () => {
  it("marks a multi-select option before the answer is sent", async () => {
    const onChoose = vi.fn();
    const { container } = await mount(
      <AskBlock
        question={{ ...question, multi: true }}
        onChoose={onChoose}
        onAbort={() => {}}
      />,
    );

    const a = button(container, "A");
    const send = button(container, "发送");
    await click(a);

    expect(a?.getAttribute("aria-pressed")).toBe("true");
    expect(send?.hasAttribute("disabled")).toBe(false);
    expect(onChoose).not.toHaveBeenCalled();

    await click(send);
    expect(onChoose).toHaveBeenCalledWith({ ...question, multi: true }, ["A"]);
  });

  it("shows the selected option and locks the card while sending", async () => {
    const { container } = await mount(
      <AskBlock
        question={question}
        pending={{ id: question.id, selections: ["B"] }}
        onChoose={() => {}}
        onAbort={() => {}}
      />,
    );

    const a = button(container, "A");
    const b = button(container, "B");
    const giveUp = button(container, "放弃");

    expect(a?.hasAttribute("disabled")).toBe(true);
    expect(b?.getAttribute("aria-pressed")).toBe("true");
    expect(giveUp?.hasAttribute("disabled")).toBe(true);
    expect(container.querySelector(".ask-status")).toBeNull();
  });

  it("submits a single-choice answer on the first click", async () => {
    const onChoose = vi.fn();
    const { container } = await mount(
      <AskBlock question={question} onChoose={onChoose} onAbort={() => {}} />,
    );

    await click(button(container, "A"));
    expect(onChoose).toHaveBeenCalledWith(question, ["A"]);
  });
});
