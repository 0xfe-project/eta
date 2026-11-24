/**
 * What an ACP agent did, retold in the kernel's vocabulary.
 *
 * The agent reports `session/update` notifications while a prompt runs: chunks of what it says
 * and thinks, a `tool_call` when it starts one, `tool_call_update`s as it goes and when it ends.
 * An eta session hears runs as turns: a turn is one assistant message (its text, its thinking,
 * its tool calls) and then the results of those calls. So this folds the updates into that shape:
 *
 * - The first chunk or tool call opens an assistant message (`turn:start`, `message:start`); each
 *   update after it is a `message:update` with a snapshot, as a provider stream would be.
 * - The message ends when one of its tool calls comes back, when the agent starts a message under
 *   another `messageId`, or when the prompt ends. Ending it is `message:end` (the journal writes
 *   it), `turn:end`, and a `tool:start` for each of its calls.
 * - A call that reached `completed` or `failed` is `tool:end` and a tool-result message.
 *
 * What the agent says about a call beyond its text (its kind, the files it touched, a diff) rides
 * on the result as `details.acp`.
 */
import type {
  ContentBlock,
  SessionUpdate,
  ToolCallContent,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import type { Usage as AcpUsage } from "@agentclientprotocol/sdk/unstable";
import type {
  AgentMessage,
  AssistantMessage,
  AssistantMessageEvent,
  RunDelegateContext,
  Usage,
} from "@eta/core";
import { unreportedUsage, withUsageEvidence } from "@eta/core";

type Block = AssistantMessage["content"][number];

type ToolResultContent = Extract<
  AgentMessage,
  { role: "toolResult" }
>["content"];

/** What a call's tool result carries beside its content. */
export interface AcpToolResultDetails {
  acp: {
    title?: string;
    kind?: string;
    locations?: { path: string; line?: number | null }[];
    diffs?: { path: string; oldText?: string | null; newText: string }[];
    rawOutput?: unknown;
  };
}

interface OpenMessage {
  turnId: string;
  message: AssistantMessage;
  nativeId: string | undefined;
}

interface PendingCall {
  name: string;
  title: string | undefined;
  kind: string | undefined;
  args: Record<string, unknown>;
  turnId: string;
  startedAt: number;
  content: readonly ToolCallContent[];
  locations: { path: string; line?: number | null }[];
  rawOutput: unknown;
}

export interface TranslatorTarget {
  readonly runId: string;
  readonly emit: RunDelegateContext["emit"];
  readonly push: RunDelegateContext["push"];
  readonly noteTurn: RunDelegateContext["noteTurn"];
}

export interface TranslatorIdentity {
  nativeSessionId: string;
  /** The runtime, as the message's provider (`acp.gemini`). */
  provider: string;
  /** The model in effect, as far as the agent said. */
  model: string;
}

/**
 * The tokens of a prompt turn, as the agent answered the prompt with them (`PromptResponse.usage`,
 * unstable in ACP). `usage_update` is no help here: it tells how full the context window is and
 * what the session cost, not what was used. ACP's `totalTokens` is the sum of every kind, so its
 * input does not hold the cache's reads and writes, as eta counts them too. Whether thought tokens
 * are a part of `outputTokens` or beside them is not said; the total tells which: when the parts
 * only add up with them, they are beside, and eta's `output` (which holds its reasoning) gets them.
 */
export function usageOfTurn(reported: AcpUsage): Usage {
  const count = (value: number | null | undefined): number =>
    typeof value === "number" && Number.isFinite(value) && value > 0
      ? value
      : 0;
  const input = count(reported.inputTokens);
  const cacheRead = count(reported.cachedReadTokens);
  const cacheWrite = count(reported.cachedWriteTokens);
  const thought =
    typeof reported.thoughtTokens === "number"
      ? count(reported.thoughtTokens)
      : undefined;
  const parts = input + count(reported.outputTokens) + cacheRead + cacheWrite;
  const beside =
    thought !== undefined &&
    thought > 0 &&
    parts + thought === count(reported.totalTokens);
  const output = count(reported.outputTokens) + (beside ? thought : 0);
  return withUsageEvidence(
    {
      ...emptyUsage(),
      input,
      output,
      cacheRead,
      cacheWrite,
      ...(thought === undefined ? {} : { reasoning: thought }),
      totalTokens: input + output + cacheRead + cacheWrite,
    },
    {
      input: reported.inputTokens,
      output: reported.outputTokens,
      cacheRead: reported.cachedReadTokens,
      cacheWrite: reported.cachedWriteTokens,
    },
  );
}

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** A call's raw input as an object. */
function argumentsOf(input: unknown): Record<string, unknown> {
  if (input === undefined || input === null) return {};
  if (typeof input === "object" && !Array.isArray(input))
    return input as Record<string, unknown>;
  return { input };
}

/** A content block as words: what a chunk that is not text is told as. */
function wordsOf(block: ContentBlock): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "image":
      return "[image]";
    case "audio":
      return "[audio]";
    case "resource_link":
      return block.uri;
    case "resource":
      return "text" in block.resource
        ? block.resource.text
        : block.resource.uri;
    default:
      return "";
  }
}

function resultContent(content: readonly ToolCallContent[]): ToolResultContent {
  const out: ToolResultContent = [];
  for (const item of content) {
    if (item.type === "content") {
      const block = item.content;
      if (block.type === "image")
        out.push({ type: "image", data: block.data, mimeType: block.mimeType });
      else out.push({ type: "text", text: wordsOf(block) });
    } else if (item.type === "diff") {
      out.push({
        type: "text",
        text: `--- ${item.path}\n+++ ${item.path}\n${lines("-", item.oldText)}${lines("+", item.newText)}`,
      });
    }
  }
  return out;
}

function lines(sign: string, text: string | null | undefined): string {
  if (text === undefined || text === null || text === "") return "";
  return `${text
    .split("\n")
    .map((line) => `${sign}${line}`)
    .join("\n")}\n`;
}

function textOf(content: ToolResultContent): string {
  return content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
}

export class Translator {
  readonly #target: TranslatorTarget;
  readonly #identity: TranslatorIdentity;
  #open: OpenMessage | undefined;
  readonly #pending = new Map<string, PendingCall>();
  /** The calls whose result is written: an update that comes after has nowhere to land. */
  readonly #done = new Set<string>();
  /** The agent's running cost, and how much of it the messages so far were charged. */
  #cost: number;
  #charged: number;
  /** The prompt turn's tokens, when the agent answered with them: the last message carries them. */
  #tokens: Usage | undefined;

  constructor(
    target: TranslatorTarget,
    identity: TranslatorIdentity,
    /** The cost charged before this prompt: the agent reports a running total. */
    charged = 0,
  ) {
    this.#target = target;
    this.#identity = identity;
    this.#cost = charged;
    this.#charged = charged;
  }

  /** The running cost charged so far, for the next prompt of the same agent session. */
  get charged(): number {
    return this.#charged;
  }

  /** The agent said which model is in effect: the messages from here on are that model's. */
  setModel(model: string): void {
    if (model !== this.#identity.model) {
      this.#identity.model = model;
      this.#target.emit("context:observed", {
        runId: this.#target.runId,
        nativeSessionId: this.#identity.nativeSessionId,
        model,
        observedAt: Date.now(),
        used: null,
        window: null,
        reason: "model",
      });
    }
  }

  /** Whether the agent has told of this call: a permission request may be the first to name it. */
  knows(toolCallId: string): boolean {
    return this.#pending.has(toolCallId) || this.#done.has(toolCallId);
  }

  see(update: SessionUpdate): void {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        this.#text(wordsOf(update.content), update.messageId ?? undefined);
        break;
      case "agent_thought_chunk":
        this.#thinking(wordsOf(update.content), update.messageId ?? undefined);
        break;
      case "tool_call":
      case "tool_call_update":
        this.call(update);
        break;
      case "usage_update":
        // How full the context is (`used`, `size`) and the running cost: no tokens used to count.
        // Those come with the prompt's answer, if the agent gives them (`usageOfTurn`).
        this.#target.emit("context:observed", {
          runId: this.#target.runId,
          nativeSessionId: this.#identity.nativeSessionId,
          model: this.#identity.model,
          observedAt: Date.now(),
          used: update.used,
          window: update.size,
        });
        if (typeof update.cost?.amount === "number")
          this.#cost = update.cost.amount;
        break;
      default:
        // A replayed user message, a plan, the agent's commands and modes: not the transcript's.
        break;
    }
  }

  /** A call as the agent tells it now: its start, more of it, or its end. */
  call(update: ToolCallUpdate): void {
    const id = update.toolCallId;
    if (this.#done.has(id)) return;
    let call = this.#pending.get(id);
    if (call === undefined) {
      call = this.#callStarted(id, update);
    } else {
      this.#callChanged(id, call, update);
    }
    if (update.content !== undefined && update.content !== null)
      call.content = update.content;
    if (update.locations !== undefined && update.locations !== null)
      call.locations = update.locations.map((location) => ({
        path: location.path,
        ...(location.line === undefined ? {} : { line: location.line }),
      }));
    if (update.rawOutput !== undefined) call.rawOutput = update.rawOutput;
    if (update.status === "completed" || update.status === "failed") {
      this.#callEnded(id, call, update.status === "failed");
      return;
    }
    if (update.status === "in_progress" && call.content.length > 0) {
      this.#target.emit("tool:update", {
        runId: this.#target.runId,
        turnId: call.turnId,
        toolCallId: id,
        toolName: call.name,
        partialResult: {
          content: [
            { type: "text", text: textOf(resultContent(call.content)) },
          ],
        },
      });
    }
  }

  /**
   * The prompt ended: the message in flight ends with it. A call that never came back gets a
   * result that says so, or the transcript would hold a call nobody answered.
   */
  finish(
    outcome: "completed" | "aborted" | "failed",
    error?: string,
    /** What the agent said the turn used, if it said; else its messages report no tokens. */
    tokens?: AcpUsage | null,
  ): void {
    if (tokens !== undefined && tokens !== null)
      this.#tokens = usageOfTurn(tokens);
    if (!this.#open) {
      this.#target.emit("usage:detached", {
        usage: this.#tokens ?? unreportedUsage(),
      });
      this.#tokens = undefined;
    }
    this.#close(
      outcome === "aborted"
        ? "aborted"
        : outcome === "failed"
          ? "error"
          : "stop",
      error,
      true,
    );
    for (const [callId, call] of [...this.#pending]) {
      this.#result(
        callId,
        call,
        [
          {
            type: "text",
            text:
              outcome === "aborted"
                ? "The call was stopped with the turn."
                : "The agent reported no result for this call.",
          },
        ],
        true,
      );
    }
  }

  #ensure(nativeId: string | undefined): OpenMessage {
    const open = this.#open;
    if (open !== undefined) {
      // A message under another id is the agent's next message, not more of this one.
      if (
        nativeId === undefined ||
        open.nativeId === undefined ||
        open.nativeId === nativeId
      ) {
        open.nativeId ??= nativeId;
        return open;
      }
      this.#close("stop");
    }
    this.#target.noteTurn();
    const turnId = crypto.randomUUID();
    const message: AssistantMessage = {
      role: "assistant",
      content: [],
      api: this.#identity.provider,
      provider: this.#identity.provider,
      model: this.#identity.model,
      usage: emptyUsage(),
      stopReason: "stop",
      timestamp: Date.now(),
    };
    this.#open = { turnId, message, nativeId };
    const { runId, emit } = this.#target;
    emit("turn:start", {
      runId,
      turnId,
      contextParts: {
        system: 0,
        persona: 0,
        user: 0,
        assistant: 0,
        toolDefs: 0,
        total: 0,
      },
    });
    emit("message:start", { runId, turnId });
    this.#update({ type: "start", partial: message });
    return this.#open;
  }

  #update(event: AssistantMessageEvent): void {
    const open = this.#open;
    if (open === undefined) return;
    this.#target.emit("message:update", {
      runId: this.#target.runId,
      turnId: open.turnId,
      message: structuredClone(open.message),
      event: structuredClone({
        ...event,
        partial: open.message,
      } as AssistantMessageEvent),
    });
  }

  #text(text: string, nativeId: string | undefined): void {
    if (text === "") return;
    const open = this.#ensure(nativeId);
    const blocks = open.message.content;
    let index = blocks.length - 1;
    if (blocks[index]?.type !== "text") {
      blocks.push({ type: "text", text: "" });
      index = blocks.length - 1;
      this.#update({
        type: "text_start",
        contentIndex: index,
        partial: open.message,
      });
    }
    (blocks[index] as Extract<Block, { type: "text" }>).text += text;
    this.#update({
      type: "text_delta",
      contentIndex: index,
      delta: text,
      partial: open.message,
    });
  }

  #thinking(text: string, nativeId: string | undefined): void {
    if (text === "") return;
    const open = this.#ensure(nativeId);
    const blocks = open.message.content;
    let index = blocks.length - 1;
    if (blocks[index]?.type !== "thinking") {
      blocks.push({ type: "thinking", thinking: "" });
      index = blocks.length - 1;
      this.#update({
        type: "thinking_start",
        contentIndex: index,
        partial: open.message,
      });
    }
    (blocks[index] as Extract<Block, { type: "thinking" }>).thinking += text;
    this.#update({
      type: "thinking_delta",
      contentIndex: index,
      delta: text,
      partial: open.message,
    });
  }

  #callStarted(callId: string, update: ToolCallUpdate): PendingCall {
    const open = this.#ensure(undefined);
    const args = argumentsOf(update.rawInput);
    const name = update.name ?? update.title ?? "tool";
    open.message.content.push({
      type: "toolCall",
      id: callId,
      name,
      arguments: args,
    });
    const call: PendingCall = {
      name,
      title: update.title ?? undefined,
      kind: update.kind ?? undefined,
      args,
      turnId: open.turnId,
      startedAt: Date.now(),
      content: [],
      locations: [],
      rawOutput: undefined,
    };
    this.#pending.set(callId, call);
    this.#update({
      type: "toolcall_start",
      contentIndex: open.message.content.length - 1,
      partial: open.message,
    });
    return call;
  }

  #callIndex(callId: string): number {
    return (
      this.#open?.message.content.findIndex(
        (block) => block.type === "toolCall" && block.id === callId,
      ) ?? -1
    );
  }

  /**
   * An agent may open a call bare and fill in its input after: the last word stands. The call
   * keeps the name it was opened under (the tool, for the agents that title a call by its tool
   * first and by what it does after) unless the agent names the tool outright; the title it
   * ends with rides on the result.
   */
  #callChanged(
    callId: string,
    call: PendingCall,
    update: ToolCallUpdate,
  ): void {
    if (typeof update.title === "string") call.title = update.title;
    if (typeof update.kind === "string") call.kind = update.kind;
    const named = typeof update.name === "string" ? update.name : undefined;
    const renamed = named !== undefined && named !== call.name;
    if (update.rawInput === undefined && !renamed) return;
    if (update.rawInput !== undefined) call.args = argumentsOf(update.rawInput);
    // The name is the call's for good once its message is written.
    const open = this.#open;
    const index = this.#callIndex(callId);
    if (open === undefined || index < 0) return;
    if (named !== undefined) call.name = named;
    const block = open.message.content[index] as Extract<
      Block,
      { type: "toolCall" }
    >;
    block.name = call.name;
    block.arguments = call.args;
    this.#update({
      type: "toolcall_end",
      contentIndex: index,
      toolCall: structuredClone(block),
      partial: open.message,
    });
  }

  #callEnded(callId: string, call: PendingCall, failed: boolean): void {
    // The call came back: the message that made it is over.
    if (this.#callIndex(callId) >= 0) this.#close("toolUse");
    let content = resultContent(call.content);
    if (content.length === 0 && call.rawOutput !== undefined)
      content = [
        {
          type: "text",
          text:
            typeof call.rawOutput === "string"
              ? call.rawOutput
              : JSON.stringify(call.rawOutput),
        },
      ];
    this.#result(callId, call, content, failed);
  }

  #result(
    callId: string,
    call: PendingCall,
    content: ToolResultContent,
    isError: boolean,
  ): void {
    this.#pending.delete(callId);
    this.#done.add(callId);
    const diffs = call.content.flatMap((item) =>
      item.type === "diff"
        ? [
            {
              path: item.path,
              ...(item.oldText === undefined ? {} : { oldText: item.oldText }),
              newText: item.newText,
            },
          ]
        : [],
    );
    const details: AcpToolResultDetails = {
      acp: {
        ...(call.title === undefined ? {} : { title: call.title }),
        ...(call.kind === undefined ? {} : { kind: call.kind }),
        ...(call.locations.length === 0 ? {} : { locations: call.locations }),
        ...(diffs.length === 0 ? {} : { diffs }),
        ...(call.rawOutput === undefined ? {} : { rawOutput: call.rawOutput }),
      },
    };
    const detailed = Object.keys(details.acp).length === 0 ? {} : { details };
    const { runId, emit, push } = this.#target;
    emit("tool:end", {
      runId,
      turnId: call.turnId,
      toolCallId: callId,
      toolName: call.name,
      result: { content, ...detailed, isError },
      isError,
      terminate: false,
      durationMs: Date.now() - call.startedAt,
    });
    push({
      role: "toolResult",
      toolCallId: callId,
      toolName: call.name,
      content,
      ...detailed,
      isError,
      timestamp: Date.now(),
    });
  }

  #close(
    stopReason: AssistantMessage["stopReason"],
    errorMessage?: string,
    final = false,
  ): void {
    const open = this.#open;
    if (open === undefined) return;
    this.#open = undefined;
    const { runId, emit, push } = this.#target;
    const message = open.message;
    message.model = this.#identity.model;
    message.stopReason =
      stopReason === "stop" &&
      message.content.some((block) => block.type === "toolCall")
        ? "toolUse"
        : stopReason;
    if (errorMessage !== undefined) message.errorMessage = errorMessage;
    const cost = Math.max(0, this.#cost - this.#charged);
    this.#charged = this.#cost;
    // A message is charged the turn's tokens only when it is the turn's last; the others, and every
    // message of an agent that never says, report none (which is not zero).
    message.usage = this.#tokens ?? unreportedUsage();
    // ACP bills the entire prompt once. Its intermediate tool messages are not missing bills.
    if (!final) Object.assign(message.usage, { billedWithPrompt: true });
    this.#tokens = undefined;
    message.usage.cost.total = cost;
    this.#open = open;
    this.#update(
      message.stopReason === "error" || message.stopReason === "aborted"
        ? { type: "error", reason: message.stopReason, error: message }
        : {
            type: "done",
            reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
            message,
          },
    );
    this.#open = undefined;
    push(message);
    emit("turn:end", {
      runId,
      turnId: open.turnId,
      message,
      toolResults: [],
      usage: message.usage,
    });
    for (const block of message.content) {
      if (block.type !== "toolCall") continue;
      emit("tool:start", {
        runId,
        turnId: open.turnId,
        toolCallId: block.id,
        toolName: block.name,
        args: this.#pending.get(block.id)?.args ?? block.arguments,
      });
    }
  }
}
