/**
 * btw — a side request next to the run (port of eta-agent's `harness/btw.ts`,
 * the side-request half).
 *
 * Someone asks the agent something while it is working. The honest answer is a
 * *request*, not a second session: it inherits what the run is, and it does not
 * disturb it.
 *
 * What it inherits, read fresh on every ask and never cached (a model or toolset
 * switch applies to the very next question):
 * - the main run's request state — model, thinking level, tool declarations,
 *   system prompt, tool context, retry policy — through `requestState()`, so
 *   there is no second set of selectors to keep in sync and no override state
 *   that can drift from the run it is meant to match;
 * - the tools, minus `ask_user`. That tool waits for a human, and the UI has one
 *   question slot that the main run owns: a side request that asked would either
 *   steal it or hang until timeout, which is the opposite of a channel that
 *   answers in seconds. So the tool is subtracted from the declarations, and a
 *   model that calls it anyway gets an unknown-tool result rather than a wait.
 *
 * What it does not do: block the run (it is a plain promise the caller may await
 * or not), or run forever. A per-request cap and a shared budget across the
 * question bound it, the loop stops after a few tool turns, and running out
 * mid-way still answers with what it knows — a stopped answer is still the
 * truth, and a thread that refuses to answer over its own bookkeeping is worse
 * than one that says less.
 */

import type { Api, SimpleStreamOptions } from "@earendil-works/pi-ai";
import {
  type AgentMessage,
  type AssistantMessage,
  type KernelModels,
  type Message,
  type Model,
  type RequestState,
  type ToolCall,
} from "@eta/core";
import { addUsage, emptyUsage, type Usage } from "@eta/core/storage";

/** Output cap per request and across one question: turns add up, so the budget is shared. */
export const SIDE_MAX_TOKENS = 1024;
export const SIDE_TOKEN_BUDGET = 4096;
/** Turns one question may spend on tools before the answer is demanded. */
export const SIDE_MAX_TOOL_TURNS = 4;

/** The tool a side request never inherits. */
export const SIDE_EXCLUDED_TOOLS: ReadonlySet<string> = new Set(["ask_user"]);

export interface BtwSideRequest {
  threadId: string;
  question: string;
  /** Everything the thread already knows, oldest first. */
  messages: AgentMessage[];
}

export interface BtwToolStep {
  tool: string;
  ok: boolean;
  at: number;
}

/** What a side request gives back: the answer, what it cost, and what it ran. */
export interface BtwSideAnswer {
  text: string;
  usage: Usage;
  steps: BtwToolStep[];
}

export type BtwSideAsk = (request: BtwSideRequest) => Promise<BtwSideAnswer>;

export interface BtwSideAskDeps {
  models: KernelModels;
  /**
   * The main run's request state as of now. Read per request, never cached, so a
   * side request inherits a model or toolset switch the moment it happens.
   */
  requestState: () => Promise<RequestState | undefined>;
  /**
   * Run one tool call through the kernel's own chain (middleware, gates, the tool
   * context the prompt was built with). A tool failure arrives as an error result,
   * so the side model sees a failed tool rather than a crashed request.
   */
  executeTool: (
    call: ToolCall,
    info: { threadId: string; toolContext: unknown; turn: number },
  ) => Promise<AgentMessage>;
  /** Project the thread into provider messages, as a run does for its transcript. */
  toProviderMessages?:
    | ((messages: readonly AgentMessage[]) => Message[])
    | undefined;
  /** A side answer is real spend; the host records it against the session. */
  onUsage?: ((usage: Usage, threadId: string) => void) | undefined;
}

/** What a run answers when a tool it does not have is called. */
function unknownToolResult(call: ToolCall): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: "text", text: `unknown tool: ${call.name}` }],
    isError: true,
    timestamp: Date.now(),
  } as AgentMessage;
}

/** The text an assistant message said, without its thinking or tool calls. */
function textOf(message: AssistantMessage): string {
  return message.content
    .filter(
      (part): part is { type: "text"; text: string } => part.type === "text",
    )
    .map((part) => part.text)
    .join("\n");
}

function sideUser(text: string, at: number): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: at,
  } as AgentMessage;
}

/** The stock side ask: a bounded request-and-tools round on the run's own model, prompt and tools. */
export function btwSideAsk(deps: BtwSideAskDeps): BtwSideAsk {
  const project =
    deps.toProviderMessages ??
    ((messages: readonly AgentMessage[]): Message[] => messages as Message[]);
  return async (request: BtwSideRequest): Promise<BtwSideAnswer> => {
    const state = await deps.requestState();
    if (state === undefined)
      throw new Error("no session to inherit the side request from");
    const model = state.model;
    if (model === undefined)
      throw new Error("no model configured for this session");

    const tools = state.tools.filter(
      (tool) => !SIDE_EXCLUDED_TOOLS.has(tool.name),
    );
    const skipped = state.missingToolNames.filter(
      (name) => !SIDE_EXCLUDED_TOOLS.has(name),
    );
    const messages: AgentMessage[] = [
      ...request.messages,
      sideUser(request.question, Date.now()),
    ];
    const steps: BtwToolStep[] = [];
    let usage = emptyUsage();
    let budget = SIDE_TOKEN_BUDGET;
    let text = "";

    for (let turn = 0; ; turn += 1) {
      const response = await complete(
        deps.models,
        model,
        state,
        messages,
        project,
        tools,
        Math.min(SIDE_MAX_TOKENS, budget),
      );
      usage = addUsage(usage, response.usage);
      // The budget is what the whole question cost, not what its last turn cost.
      budget -= response.usage?.totalTokens ?? 0;
      text = textOf(response);
      const calls = response.content.filter(
        (part): part is ToolCall => part.type === "toolCall",
      );
      if (response.stopReason === "error") {
        throw new Error(response.errorMessage ?? "the side request failed");
      }
      if (calls.length === 0 || turn >= SIDE_MAX_TOOL_TURNS || budget <= 0) {
        if (calls.length > 0) {
          text = [
            text,
            `(the side request stopped at ${calls.length} pending tool calls: its turn or token budget ran out)`,
          ]
            .filter((part) => part.length > 0)
            .join("\n");
        }
        break;
      }
      messages.push(response);
      for (const call of calls) {
        // A model can call a tool that was never declared. For the excluded
        // tools that must not become a wait: the answer is "unknown tool",
        // the same thing a run says for a tool it does not have.
        const result = SIDE_EXCLUDED_TOOLS.has(call.name)
          ? (unknownToolResult(call) as AgentMessage)
          : await deps.executeTool(call, {
              threadId: request.threadId,
              toolContext: state.toolContext,
              turn,
            });
        steps.push({
          tool: call.name,
          ok: !(result as { isError?: boolean }).isError,
          at: Date.now(),
        });
        messages.push(result);
      }
    }

    // An active tool the session never defined would have made a run fail. Here the
    // request still answers, with the gap admitted.
    const note =
      skipped.length === 0
        ? ""
        : `\n(unavailable this time: ${skipped.join(", ")})`;
    const answer =
      text.length === 0 ? "(the side request returned no text)" : text + note;
    deps.onUsage?.(usage, request.threadId);
    return { text: answer, usage, steps };
  };
}

/** One side turn: the run's own prompt/model/thinking, this turn's cap, and no reasoning override. */
async function complete(
  models: KernelModels,
  model: Model<Api>,
  state: RequestState,
  messages: AgentMessage[],
  project: (messages: readonly AgentMessage[]) => Message[],
  tools: RequestState["tools"],
  maxTokens: number,
): Promise<AssistantMessage> {
  const streamOptions: SimpleStreamOptions = {
    ...(state.streamOptions ?? {}),
    maxTokens,
    // "off" is the kernel's spelling for "no reasoning field at all".
    ...(state.thinkingLevel === "off"
      ? {}
      : { reasoning: state.thinkingLevel }),
  };
  return await models.completeSimple(
    model,
    {
      systemPrompt: state.systemPrompt,
      messages: project(messages),
      ...(tools.length === 0 ? {} : { tools }),
    },
    streamOptions,
  );
}

/**
 * BtwManager — the threads a side request belongs to (port of eta-agent's
 * `BtwManager`, `harness/btw.ts`).
 *
 * The side request above answers one question. This is the bookkeeping around it:
 * a thread is a small panel beside the run, holding the questions someone asked
 * while it worked, what came back, and what the answers had to run to get there.
 *
 * Four rules, all from eta-agent:
 *
 * - **A thread is not the transcript.** Side questions and their answers are
 *   replayed *inline* for the side request (`messagesFor`) and are never injected
 *   into the main session, so a tangent cannot change what the run is doing. What
 *   does reach the main session is a *note* — and only when someone saves one.
 * - **A failed request leaves no exchange.** A placeholder answer would replay as
 *   something the model said, so a failure records `error` and nothing else.
 * - **Saving while the run is busy queues.** The note is flushed at the next run
 *   boundary (`flushQueued`), because injecting text into a running turn would
 *   arrive as a steering message and change the run's course.
 * - **The journal is the history.** A saved note becomes a `btw` entry; threads
 *   that were never saved are panel state, and `replay` rebuilds what the entries
 *   say about them.
 */
import type { Emit } from "@eta/core";
import type { Entry } from "@eta/core/session";

export type BtwSaveState = "not-saved" | "queued" | "saved";

export interface BtwExchange {
  question: string;
  answer: string;
  at: number;
  /** Set when the side request ran tools; absent means nothing was looked up. */
  steps?: BtwToolStep[] | undefined;
}

export interface BtwThread {
  id: string;
  kind: "contextual" | "tangent";
  exchanges: BtwExchange[];
  saveState: BtwSaveState;
  /** Set from the moment a question is asked until the side request resolves. */
  pending?: { question: string; at: number } | undefined;
  /** Why the last question did not get an answer; cleared by the next one. */
  error?: string | undefined;
}

/** The seed a thread asks with: the main context, without any visible side note. */
export type BtwBuildContext = (
  entries: readonly Entry[],
  leafId: string | null,
) => { messages: AgentMessage[] };

function sideAssistant(text: string, at: number): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "unknown",
    provider: "unknown",
    model: "btw",
    usage: emptyUsage(),
    stopReason: "stop",
    timestamp: at,
  } as unknown as AgentMessage;
}

/** What handoff hands the main run: the notes, as a follow-up it can fold in. */
export function handoffText(
  id: string,
  exchanges: readonly BtwExchange[],
): string {
  return [
    `[btw ${id}] notes taken beside the run:`,
    exchanges
      .map((exchange) =>
        exchange.answer.length === 0
          ? `- ${exchange.question}`
          : `- ${exchange.question} -> ${exchange.answer}`,
      )
      .join("\n"),
    "Fold these in or summarize them for the user.",
  ].join("\n");
}

export interface BtwManagerOptions {
  /** Builds a contextual thread's seed from the journal's entries. */
  buildContext: BtwBuildContext;
  /**
   * Where a saved note goes. In the harness this writes a `btw` entry into the
   * journal — the thread's history is the journal's, not this panel's.
   */
  onVisibleNote?: ((note: string) => void | Promise<void>) | undefined;
  /** The bus, for the `btw:*` events a UI watches. */
  observe?: Emit | undefined;
  /** How a thread gets answered. Without one a question fails with the reason. */
  sideAsk?: BtwSideAsk | undefined;
}

export class BtwManager {
  private readonly threads = new Map<string, BtwThread>();
  private sequence = 0;
  /** Seed cache per thread; contextual threads rebuild it from entries. */
  private readonly seeds = new Map<string, AgentMessage[]>();
  /** Threads whose notes are being written right now, so a second flush cannot double them. */
  private readonly flushing = new Set<string>();

  private readonly buildContext: BtwBuildContext;
  private readonly onVisibleNote:
    | ((note: string) => void | Promise<void>)
    | undefined;
  private readonly observe: Emit | undefined;
  private readonly sideAsk: BtwSideAsk | undefined;

  constructor(options: BtwManagerOptions) {
    this.buildContext = options.buildContext;
    this.onVisibleNote = options.onVisibleNote;
    this.observe = options.observe;
    this.sideAsk = options.sideAsk;
  }

  create(kind: BtwThread["kind"]): BtwThread {
    const thread: BtwThread = {
      id: `btw-${++this.sequence}`,
      kind,
      exchanges: [],
      saveState: "not-saved",
    };
    this.threads.set(thread.id, thread);
    this.observe?.("btw:opened", { threadId: thread.id, kind: thread.kind });
    return thread;
  }

  get(id: string): BtwThread | undefined {
    return this.threads.get(id);
  }

  list(): BtwThread[] {
    return [...this.threads.values()];
  }

  /**
   * Seed a contextual thread with the main session's context, minus any visible
   * side note — a thread should not inherit the notes of earlier ones. If the
   * context builder cannot do its job (a damaged chain), the messages are taken
   * straight off the entries rather than leaving the thread with no context.
   */
  seedFrom(
    threadId: string,
    entries: readonly Entry[],
    leafId: string | null,
  ): void {
    const thread = this.threads.get(threadId);
    if (thread === undefined || thread.kind !== "contextual") return;
    try {
      this.seeds.set(
        threadId,
        this.buildContext(entries, leafId).messages.filter(
          (message) => !isVisibleBtwEntry(message),
        ),
      );
    } catch {
      this.seeds.set(
        threadId,
        entries
          .filter(
            (entry): entry is Extract<Entry, { type: "message" }> =>
              entry.type === "message",
          )
          .map((entry) => entry.message),
      );
    }
  }

  /** What the side request sends: the seed, then the recorded notes inline. */
  messagesFor(threadId: string): AgentMessage[] {
    const thread = this.threads.get(threadId);
    if (thread === undefined) return [];
    const messages: AgentMessage[] = [...(this.seeds.get(threadId) ?? [])];
    for (const exchange of thread.exchanges) {
      messages.push(sideUser(exchange.question, exchange.at));
      if (exchange.answer.length > 0)
        messages.push(sideAssistant(exchange.answer, exchange.at + 1));
    }
    return messages;
  }

  /**
   * Ask the thread and let it carry the wait: `pending` while the side request
   * runs, an answered exchange when it lands, `error` when it does not. Nothing
   * here takes the run, so the question can be answered while a loop or a goal
   * holds it.
   */
  async ask(threadId: string, question: string): Promise<void> {
    const thread = this.threads.get(threadId);
    if (thread === undefined) return;
    const sideAsk = this.sideAsk;
    if (sideAsk === undefined) {
      this.fail(threadId, "no side model configured for this session");
      return;
    }
    this.begin(threadId, question);
    try {
      const answer = await sideAsk({
        threadId,
        question,
        messages: this.messagesFor(threadId),
      });
      // The thread can be cleared while its request is in flight.
      if (!this.threads.has(threadId)) return;
      this.answer(
        threadId,
        question,
        answer.text,
        answer.steps.length === 0 ? undefined : answer.steps,
      );
    } catch (error) {
      if (this.threads.has(threadId)) {
        this.fail(
          threadId,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  /** Record a question as in flight; `answer`/`fail` settle it. */
  begin(threadId: string, question: string): void {
    const thread = this.threads.get(threadId);
    if (thread === undefined) return;
    thread.pending = { question, at: Date.now() };
    thread.error = undefined;
    this.observe?.("btw:asking", { threadId });
  }

  /**
   * Record a note: a bare note, a question with the answer it turned out to have,
   * or an answered side request — which also carries the tools it ran.
   */
  answer(
    threadId: string,
    question: string,
    answer = "",
    steps?: BtwToolStep[] | undefined,
  ): void {
    const thread = this.threads.get(threadId);
    if (thread === undefined) return;
    thread.pending = undefined;
    thread.error = undefined;
    thread.exchanges.push({
      question,
      answer,
      at: Date.now(),
      ...(steps === undefined ? {} : { steps }),
    });
    this.observe?.("btw:injected", { threadId });
  }

  /** A failed request leaves no exchange behind — a fake answer would replay as truth. */
  fail(threadId: string, message: string): void {
    const thread = this.threads.get(threadId);
    if (thread === undefined) return;
    thread.pending = undefined;
    thread.error = message;
    this.observe?.("btw:failed", { threadId, message });
  }

  /**
   * Save the thread's notes as a visible note in the main session. While the run
   * is busy the note queues and flushes at run end; otherwise it is written now and
   * the answer is the state it settled into — a caller told "saved" has a note in the
   * journal, not a write in flight.
   */
  async save(threadId: string, running: boolean): Promise<BtwSaveState> {
    const thread = this.threads.get(threadId);
    if (thread === undefined) return "not-saved";
    if (running) {
      thread.saveState = "queued";
      return thread.saveState;
    }
    await this.flushNote(thread);
    return thread.saveState;
  }

  /** Called at run boundaries: writes notes queued while the run was busy. */
  async flushQueued(): Promise<number> {
    let flushed = 0;
    for (const thread of this.threads.values()) {
      if (thread.saveState === "queued") {
        await this.flushNote(thread);
        flushed += 1;
      }
    }
    return flushed;
  }

  /**
   * Write the thread's notes.
   *
   * The in-flight set is why this is not just a loop: `save` and a run boundary
   * can both land here, and each exchange must reach the journal exactly once —
   * a note written twice would read as two tangents in the panel.
   */
  private async flushNote(thread: BtwThread): Promise<void> {
    if (this.flushing.has(thread.id)) return;
    this.flushing.add(thread.id);
    try {
      for (const note of thread.exchanges) {
        await this.onVisibleNote?.(
          note.answer.length === 0
            ? `btw ${thread.id}: ${note.question}`
            : `btw ${thread.id}: ${note.question} -> ${note.answer}`,
        );
      }
    } finally {
      this.flushing.delete(thread.id);
    }
    thread.saveState = "saved";
    this.observe?.("btw:saved", { threadId: thread.id });
  }

  /** Drop a thread from the panel; notes already written to the journal stay. */
  clear(threadId: string): boolean {
    const had = this.threads.delete(threadId);
    if (had) this.observe?.("btw:cleared", { threadId });
    return had;
  }

  /** The FollowUp text handed to the main run, carrying the thread's notes. */
  handoff(threadId: string): string | undefined {
    const thread = this.threads.get(threadId);
    if (thread === undefined || thread.exchanges.length === 0) return undefined;
    this.observe?.("btw:summarized", { threadId });
    return handoffText(thread.id, thread.exchanges);
  }

  /**
   * Rebuild threads from the journal's `btw` entries.
   *
   * A saved note is what the journal holds, so an id it never carried is numbered
   * as replayed — the note itself is the history, and a thread that came back from
   * disk says so instead of pretending it remembers the panel it was.
   */
  replay(entries: readonly Entry[]): void {
    for (const entry of entries) {
      if (entry.type !== "btw") continue;
      const payload = entry.payload as { note?: unknown } & Partial<BtwThread>;
      if (typeof payload?.note !== "string") continue;
      const id =
        typeof payload.id === "string"
          ? payload.id
          : `btw-replay-${++this.sequence}`;
      if (this.threads.has(id)) continue;
      this.threads.set(id, {
        id,
        kind: payload.kind ?? "tangent",
        exchanges: payload.exchanges ?? [],
        saveState: payload.saveState ?? "saved",
      });
    }
  }
}

/**
 * Whether a message is a visible side note rather than session context. eta-agent
 * matched a legacy `customType: "eta.btw"` message here; this fork's notes are
 * `btw` entries and never messages, so there is nothing to filter — the check
 * stays because `seedFrom` filters whatever the context builder hands it.
 */
function isVisibleBtwEntry(message: AgentMessage): boolean {
  return (
    (message as { role?: string; customType?: string }).customType === "eta.btw"
  );
}
