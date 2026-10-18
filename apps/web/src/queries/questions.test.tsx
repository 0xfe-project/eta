import { afterEach, describe, expect, it } from "@rstest/core";
import { act } from "react";
import { setWire } from "@/lib/wire";
import { conversationView, memberView, productHost } from "@/test-product";
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

const waiting = (id: string, session: string) =>
  conversationView({
    id,
    participants: [
      memberView("a1", { sessionId: session, status: "waiting_for_input" }),
    ],
  });

const ask = (questionId: string, question: string) => ({
  core: { session: "s", running: true },
  ask: { pending: { questionId, question, options: ["yes", "no"] } },
});

afterEach(async () => {
  await cleanup();
  setWire(undefined);
});

describe("the questions waiting for the user", () => {
  it("come from the sessions of the members who are waiting", async () => {
    const host = productHost({
      conversations: [
        waiting("c1", "s1"),
        conversationView({
          id: "c2",
          participants: [memberView("a2", { sessionId: "s2" })],
        }),
      ],
    });
    host.target("sessions.s1", ask("q1", "Delete the branch?"));
    host.target("sessions.s2", ask("q2", "not waiting"));
    await mount(<Questions />);
    await flush();
    expect(document.body.textContent).toContain("Delete the branch?");
    expect(document.body.textContent).not.toContain("not waiting");
  });

  it("can be narrowed to one conversation", async () => {
    const host = productHost({
      conversations: [waiting("c1", "s1"), waiting("c2", "s2")],
    });
    host.target("sessions.s1", ask("q1", "first"));
    host.target("sessions.s2", ask("q2", "second"));
    await mount(<Questions conversationId="c2" />);
    await flush();
    expect(document.body.textContent).toContain("second");
    expect(document.body.textContent).not.toContain("first");
  });

  it("are answered on the member's session, and can be given up", async () => {
    const host = productHost({ conversations: [waiting("c1", "s1")] });
    host.target("sessions.s1", ask("q1", "Delete the branch?"));
    host.handle("sessions.answer", () => ({ answered: true }));
    host.handle("sessions.askAbort", () => ({ aborted: true }));
    const { container } = await mount(<Questions />);
    await flush();
    await click(container.querySelectorAll("button")[0]);
    await click(container.querySelectorAll("button")[1]);
    await act(async () => undefined);
    expect(host.calls.map((call) => [call.action, call.args])).toEqual([
      [
        "answer",
        {
          session: "s1",
          questionId: "q1",
          response: { kind: "selection", selections: ["yes"] },
        },
      ],
      ["askAbort", { session: "s1", questionId: "q1" }],
    ]);
  });
});
