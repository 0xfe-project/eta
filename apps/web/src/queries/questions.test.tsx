import { afterEach, describe, expect, it } from "@rstest/core";
import { act } from "react";
import { setWire } from "@/lib/wire";
import { interactionView, surfaceHost } from "@/test-inbox";
import { cleanup, click, flush, mount } from "@/test-render";
import { useAnswerQuestion, useQuestions } from "./questions";

function Questions({ conversationId }: { conversationId?: string }) {
  const questions = useQuestions(conversationId);
  const { choose, abort } = useAnswerQuestion();
  return (
    <ul>
      {questions.map((question) => (
        <li key={question.id}>
          {question.prompt}
          <button type="button" onClick={() => choose(question, ["yes"])}>
            answer
          </button>
          <button type="button" onClick={() => abort(question)}>
            give up
          </button>
        </li>
      ))}
    </ul>
  );
}

afterEach(async () => {
  await cleanup();
  setWire(undefined);
});

describe("the questions waiting for the user", () => {
  it("are the inbox's pending rows that belong to a conversation", async () => {
    surfaceHost({
      interactions: [
        interactionView({ id: "i1", prompt: "Delete the branch?" }),
        interactionView({
          id: "i2",
          prompt: "already answered",
          status: "answered",
        }),
        interactionView({
          id: "i3",
          prompt: "bare session",
          conversationId: null,
        }),
      ],
    });
    await mount(<Questions />);
    await flush();
    expect(document.body.textContent).toContain("Delete the branch?");
    expect(document.body.textContent).not.toContain("already answered");
    expect(document.body.textContent).not.toContain("bare session");
  });

  it("can be narrowed to one conversation", async () => {
    surfaceHost({
      interactions: [
        interactionView({ id: "i1", prompt: "first", conversationId: "g1" }),
        interactionView({ id: "i2", prompt: "second", conversationId: "g2" }),
      ],
    });
    await mount(<Questions conversationId="g2" />);
    await flush();
    expect(document.body.textContent).toContain("second");
    expect(document.body.textContent).not.toContain("first");
  });

  it("are answered through the inbox, and can be given up", async () => {
    const host = surfaceHost({
      interactions: [
        interactionView({
          id: "i1",
          prompt: "Delete the branch?",
          options: ["yes", "no"],
        }),
      ],
    });
    host.handle("inbox.answer", () => ({ answered: true }));
    const { container } = await mount(<Questions />);
    await flush();
    await click(container.querySelectorAll("button")[0]);
    await click(container.querySelectorAll("button")[1]);
    await act(async () => undefined);
    expect(
      host.calls.map((call) => [call.target, call.action, call.args]),
    ).toEqual([
      [
        "inbox",
        "answer",
        { id: "i1", response: { kind: "selection", selections: ["yes"] } },
      ],
      ["inbox", "answer", { id: "i1", response: { kind: "none" } }],
    ]);
  });

  it("are answered in words when they have no options", async () => {
    const host = surfaceHost({
      interactions: [interactionView({ id: "i1", options: [] })],
    });
    host.handle("inbox.answer", () => ({ answered: true }));
    const { container } = await mount(<Questions />);
    await flush();
    await click(container.querySelectorAll("button")[0]);
    await act(async () => undefined);
    expect(host.calls[0]?.args).toEqual({
      id: "i1",
      response: { kind: "freeform", text: "yes" },
    });
  });
});
