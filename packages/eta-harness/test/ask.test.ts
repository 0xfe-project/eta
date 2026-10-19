/**
 * The ask channel.
 *
 * What a question must never do is hang: every path — a human answering, a
 * deadline, an abort, a run being cancelled — settles, and the model is told
 * something either way. What it must also never do is confuse two questions, or
 * let one waiting question stop a second one from being asked.
 */
import { describe, expect, it, vi } from "vitest";
import { AskRegistry, askResponseText, normalizeAskOptions } from "../src/ask";

const question = (id: string, text = "which one?") => ({
  questionId: id,
  question: text,
});

describe("the ask registry", () => {
  it("hands back what the human chose, and records it", async () => {
    const answers: { questionId: string; answers: string[] }[] = [];
    const registry = new AskRegistry({
      onAnswer: (payload) => answers.push(payload),
    });
    const pending = registry.ask(question("q1"));
    expect(registry.pendingAsks().map((ask) => ask.questionId)).toEqual(["q1"]);
    expect(
      registry.answer("q1", {
        kind: "selection",
        selections: ["beta"],
        comment: "because",
      }),
    ).toBe(true);
    await expect(pending).resolves.toEqual({
      kind: "selection",
      selections: ["beta"],
      comment: "because",
    });
    expect(answers).toEqual([
      { questionId: "q1", answers: ["beta", "because"] },
    ]);
    expect(registry.waiting).toBe(false);
    // Answering a question nobody is waiting on is a no-op, not an error.
    expect(registry.answer("q1", { kind: "none" })).toBe(false);
  });

  it("keeps several questions apart, so one answer cannot settle another", async () => {
    const registry = new AskRegistry();
    const first = registry.ask(question("q1", "first?"));
    const second = registry.ask(question("q2", "second?"));
    expect(registry.pendingAsks()).toHaveLength(2);
    registry.answer("q2", { kind: "freeform", text: "the second answer" });
    await expect(second).resolves.toEqual({
      kind: "freeform",
      text: "the second answer",
    });
    // The first is still waiting: a side request's question does not end the
    // main run's, and vice versa.
    expect(registry.pendingAsks().map((ask) => ask.questionId)).toEqual(["q1"]);
    registry.answer("q1", { kind: "freeform", text: "the first answer" });
    await expect(first).resolves.toEqual({
      kind: "freeform",
      text: "the first answer",
    });
  });

  it("expires a timed question instead of waiting forever", async () => {
    vi.useFakeTimers();
    const seen: string[] = [];
    const registry = new AskRegistry({
      observe: (action) => seen.push(action),
    });
    const pending = registry.ask(question("q1"), { timeoutMs: 1_000 });
    expect(registry.deadline("q1")).toBeGreaterThan(0);
    vi.advanceTimersByTime(1_001);
    await expect(pending).resolves.toEqual({ kind: "none" });
    expect(seen).toEqual(["asked", "expired"]);
    expect(registry.deadline("q1")).toBeUndefined();
    vi.useRealTimers();
  });

  it("settles as none when the run is aborted", async () => {
    const registry = new AskRegistry();
    const controller = new AbortController();
    const pending = registry.ask(question("q1"), { signal: controller.signal });
    controller.abort();
    await expect(pending).resolves.toEqual({ kind: "none" });
    expect(registry.waiting).toBe(false);

    // An already-aborted signal never registers the question at all.
    const never = registry.ask(question("q2"), { signal: controller.signal });
    await expect(never).resolves.toEqual({ kind: "none" });
    expect(registry.pendingAsks()).toEqual([]);
  });

  it("records a dismissal, so a replayed session does not ask it again", async () => {
    const answers: { questionId: string; answers: string[] }[] = [];
    const registry = new AskRegistry({
      onAnswer: (payload) => answers.push(payload),
    });
    const pending = registry.ask(question("q1"));
    expect(registry.abort("q1")).toBe(true);
    await expect(pending).resolves.toEqual({ kind: "none" });
    expect(answers).toEqual([{ questionId: "q1", answers: ["user-aborted"] }]);
    expect(registry.abort("q1")).toBe(false);
  });

  it("re-surfaces unanswered questions from a replayed journal", () => {
    const registry = new AskRegistry();
    registry.replay([
      { type: "goal", payload: {} },
      { type: "ask", payload: question("q1", "still open?") },
      { type: "ask", payload: question("q2", "already answered") },
      { type: "answer", payload: { questionId: "q2", answers: ["yes"] } },
    ]);
    expect(registry.pendingAsks().map((ask) => ask.questionId)).toEqual(["q1"]);
    // Re-replaying is idempotent: the question is not registered twice.
    registry.replay([{ type: "ask", payload: question("q1", "still open?") }]);
    expect(registry.pendingAsks()).toHaveLength(1);
  });

  it("can be answered without a human, and never hangs when that fails", async () => {
    const answers = new AskRegistry({
      headless: async () => ({ kind: "freeform", text: "scripted" }),
    });
    await expect(answers.ask(question("q1"))).resolves.toEqual({
      kind: "freeform",
      text: "scripted",
    });

    const broken = new AskRegistry({
      headless: async () => {
        throw new Error("no answerer");
      },
    });
    await expect(broken.ask(question("q2"))).resolves.toEqual({ kind: "none" });
  });
});

describe("ask plumbing", () => {
  it("reads what a model means by options, and says the answer back plainly", () => {
    expect(normalizeAskOptions(["one", "two"])).toEqual([
      { title: "one" },
      { title: "two" },
    ]);
    expect(
      normalizeAskOptions([{ label: "L", detail: "D" }, { value: "V" }]),
    ).toEqual([{ title: "L", description: "D" }, { title: "V" }]);
    expect(normalizeAskOptions("not an array")).toBeUndefined();
    expect(normalizeAskOptions(undefined)).toBeUndefined();

    expect(askResponseText({ kind: "selection", selections: ["a", "b"] })).toBe(
      "Selected: a, b",
    );
    expect(
      askResponseText({
        kind: "selection",
        selections: ["a"],
        comment: "why not",
      }),
    ).toBe("Selected: a — why not");
    expect(askResponseText({ kind: "freeform", text: "plain words" })).toBe(
      "plain words",
    );
    expect(askResponseText({ kind: "none" })).toBe("No answer from the user.");
  });
});
