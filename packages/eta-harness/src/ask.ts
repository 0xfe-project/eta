/**
 * The ask channel (port of eta-agent's `harness/ask.ts`).
 *
 * One question, one human, and a tool call that has to wait without stopping the
 * world. The registry is the channel: the tool hands it a question and awaits an
 * answer; the UI (or a headless caller, or a replay of a session that was killed
 * while waiting) hands back the answer.
 *
 * Four rules it exists to keep:
 * - **Never hang.** A deadline or an abort settles the ask as `none`, and the
 *   model is told nobody answered. A turn that waits forever is a turn nobody
 *   can get out of.
 * - **One at a time each, many at once.** Asks are keyed by question id, so
 *   several can be pending at once — a session answering one does not settle
 *   another, and a side request (btw) asking its own question does not block the
 *   main run.
 * - **The question is recorded before it is asked.** `onAsk` runs before the
 *   wait, so a process killed mid-question re-surfaces it (`replay`) instead of
 *   losing it.
 * - **An answer is recorded too**, so a replayed session cannot ask the same
 *   question twice.
 */

import type { AnswerPayload, AskPayload } from "@eta/core/session";
import type { HarnessTool, ToolResult } from "./tools/tool";
import { Type } from "typebox";

export type AskResponse =
  | { kind: "selection"; selections: string[]; comment?: string | undefined }
  | { kind: "freeform"; text: string }
  | { kind: "none" };

interface PendingAsk {
  payload: AskPayload;
  settle: (response: AskResponse) => void;
}

/** A caller that answers asks without a human (a test, a scripted run). */
export type HeadlessAsk = (payload: AskPayload) => Promise<AskResponse | null>;

/** Called with every settled ask, for whatever logs answers. */
export type AskObserver = (
  action: "asked" | "answered" | "canceled" | "expired",
  payload: AskPayload,
) => void;

export class AskRegistry {
  private readonly pending = new Map<string, PendingAsk>();
  private readonly deadlines = new Map<string, number>();
  private readonly observe: AskObserver | undefined;
  private readonly onAnswer: ((payload: AnswerPayload) => void) | undefined;
  private readonly headless: HeadlessAsk | undefined;

  constructor(
    options: {
      observe?: AskObserver;
      headless?: HeadlessAsk;
      onAnswer?: (payload: AnswerPayload) => void;
    } = {},
  ) {
    this.observe = options.observe;
    this.onAnswer = options.onAnswer;
    this.headless = options.headless;
  }

  /** The tool waits on this; a timeout or an abort resolves to `none`, never hangs. */
  ask(
    payload: AskPayload,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<AskResponse> {
    return new Promise<AskResponse>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (
        response: AskResponse,
        action: "answered" | "canceled" | "expired",
      ): void => {
        if (settled) return;
        settled = true;
        this.pending.delete(payload.questionId);
        this.deadlines.delete(payload.questionId);
        if (timer !== undefined) clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        this.observe?.(action, payload);
        resolve(response);
      };
      const onAbort = (): void => settle({ kind: "none" }, "canceled");
      if (options.timeoutMs !== undefined) {
        timer = setTimeout(
          settle,
          options.timeoutMs,
          { kind: "none" },
          "expired",
        );
        timer.unref?.();
        this.deadlines.set(payload.questionId, Date.now() + options.timeoutMs);
      }
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted === true) {
        settle({ kind: "none" }, "canceled");
        return;
      }
      this.pending.set(payload.questionId, {
        payload,
        settle: (response) => settle(response, "answered"),
      });
      this.observe?.("asked", payload);
      if (this.headless !== undefined) {
        const headless = this.headless;
        void Promise.resolve()
          .then(() => headless(payload))
          .then((response) => settle(response ?? { kind: "none" }, "answered"))
          .catch(() => settle({ kind: "none" }, "canceled"));
      }
    });
  }

  /** When a timed question expires (epoch ms), for a countdown; undefined without a timeout. */
  deadline(questionId: string): number | undefined {
    return this.deadlines.get(questionId);
  }

  /** Questions still waiting for a human — what a UI re-surfaces on boot. */
  pendingAsks(): AskPayload[] {
    return [...this.pending.values()].map((waiting) => waiting.payload);
  }

  /** Whether anything is still waiting. */
  get waiting(): boolean {
    return this.pending.size > 0;
  }

  /** The user dismissed a pending question: settle as none, but record it so replay never re-surfaces it. */
  abort(questionId: string): boolean {
    const waiting = this.pending.get(questionId);
    if (waiting === undefined) return false;
    this.onAnswer?.({ questionId, answers: ["user-aborted"] });
    waiting.settle({ kind: "none" });
    return true;
  }

  /** Backfill a waiting question; a real answer is recorded before it settles. */
  answer(questionId: string, response: AskResponse): boolean {
    const waiting = this.pending.get(questionId);
    if (waiting === undefined) return false;
    if (this.onAnswer !== undefined && response.kind !== "none") {
      const answers =
        response.kind === "selection"
          ? [
              ...response.selections,
              ...(response.comment === undefined ? [] : [response.comment]),
            ]
          : [response.text];
      this.onAnswer({ questionId, answers });
    }
    waiting.settle(response);
    return true;
  }

  /**
   * Re-register unanswered asks from a replayed journal (ask entries with no
   * later answer for the same question id). The re-driven tool call will ask
   * again for the same id; until then this is what makes the question visible
   * to the UI after a restart.
   */
  replay(entries: readonly { type: string; payload?: unknown }[]): void {
    const answered = new Set<string>();
    const asks: AskPayload[] = [];
    for (const entry of entries) {
      if (entry.type === "ask" && entry.payload !== undefined)
        asks.push(entry.payload as AskPayload);
      else if (entry.type === "answer" && entry.payload !== undefined) {
        answered.add((entry.payload as AnswerPayload).questionId);
      }
    }
    for (const payload of asks) {
      if (
        !answered.has(payload.questionId) &&
        !this.pending.has(payload.questionId)
      ) {
        this.pending.set(payload.questionId, {
          payload,
          settle: () => undefined,
        });
      }
    }
  }
}

/**
 * Absorb what models send anyway: options as bare strings, or with the field
 * named label/text/value/name instead of title.
 */
export function normalizeAskOptions(
  raw: unknown,
): { title: string; description?: string }[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.map((item) => {
    if (typeof item === "string") return { title: item };
    const candidate = item as Record<string, unknown>;
    const title = [
      candidate.title,
      candidate.label,
      candidate.text,
      candidate.value,
      candidate.name,
    ].find((value) => typeof value === "string");
    const description = [
      candidate.description,
      candidate.detail,
      candidate.desc,
    ].find((value) => typeof value === "string");
    return {
      title: title ?? JSON.stringify(candidate),
      ...(description === undefined ? {} : { description }),
    };
  });
}

/** What the model reads back from an ask. */
export function askResponseText(response: AskResponse): string {
  switch (response.kind) {
    case "selection":
      return `Selected: ${response.selections.join(", ")}${response.comment === undefined ? "" : ` — ${response.comment}`}`;
    case "freeform":
      return response.text;
    case "none":
      return "No answer from the user.";
  }
}

export const askSchema = Type.Object({
  question: Type.String({
    description: "What you need to know, phrased plainly",
  }),
  context: Type.Optional(
    Type.String({ description: "Why you're asking, if not obvious" }),
  ),
  options: Type.Optional(
    Type.Array(
      Type.Object({
        title: Type.String({ description: "Short label for this choice" }),
        description: Type.Optional(
          Type.String({ description: "What this choice means" }),
        ),
      }),
    ),
  ),
  allowMultiple: Type.Optional(
    Type.Boolean({ description: "Let the user pick more than one option" }),
  ),
  allowFreeform: Type.Optional(
    Type.Boolean({ description: "Let the user answer in their own words" }),
  ),
});

export interface AskUserToolDeps {
  registry: AskRegistry;
  /** Record the `ask` entry before waiting, so a killed process can re-surface it. */
  onAsk?: ((payload: AskPayload) => void | Promise<void>) | undefined;
  /** How long to wait for a human; an expired ask is `none`. */
  timeoutMs?: number | undefined;
}

/** The ask_user tool: one question, and the answer the model is handed back. */
export function createAskUserTool(
  deps: AskUserToolDeps,
): HarnessTool<object | undefined, typeof askSchema, AskResponse | undefined> {
  return {
    name: "ask_user",
    label: "ask_user",
    description:
      "Ask the user one question and wait for the answer. Use only when you genuinely can't pick a reasonable default yourself.",
    parameters: askSchema,
    async execute(params, run): Promise<ToolResult<AskResponse | undefined>> {
      const options = normalizeAskOptions(params.options);
      const payload: AskPayload = {
        questionId: run.call.toolCallId,
        question: params.question,
        ...(options === undefined
          ? {}
          : { options: options.map((option) => option.title) }),
        ...(params.allowMultiple === undefined
          ? {}
          : { multi: params.allowMultiple }),
      };
      await deps.onAsk?.(payload);
      const response = await deps.registry.ask(payload, {
        ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
        ...(run.call.signal === undefined ? {} : { signal: run.call.signal }),
      });
      return {
        content: [{ type: "text", text: askResponseText(response) }],
        details: response,
      };
    },
  };
}
