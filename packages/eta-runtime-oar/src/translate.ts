/**
 * What a runtime did, retold in the kernel's vocabulary.
 *
 * oar reports one fact per event: a piece of text, a tool call that started, its input, its end,
 * the turn's end, usage. An eta session hears runs as turns: a turn is one assistant message (its
 * text, its thinking, its tool calls) and then the results of those calls. So this folds the
 * runtime's facts into that shape as they arrive:
 *
 * - The first text, thought or tool call opens an assistant message (`turn:start`,
 *   `message:start`); each fact after it is a `message:update` with a snapshot, as a provider
 *   stream would be.
 * - The message ends when one of its tool calls comes back, when the runtime starts a message
 *   under another id, or when the turn ends. Ending it is `message:end` (the journal writes it),
 *   `turn:end` with what it cost, and a `tool:start` for each of its calls.
 * - A call's end is `tool:end` and a tool-result message, which the journal writes too.
 *
 * Only the root agent's facts become the transcript. A runtime's own subagent works inside one of
 * the root's tool calls, so its tool calls are told as progress (`tool:update`) of that call, and
 * its steps ride on that call's result as `details.children` for the run log to draw.
 *
 * Usage is a running total from oar; a message costs what the total grew by since the last one.
 *
 * A call to one of the host's tools is told as the host's: under its own name, with the `details`
 * it left, on the same terms as a call the kernel ran itself (`HostCalls`).
 */
import type { Event, TokenTotals, ToolOutputPart } from "@botiverse/oar";
import type {
  AgentMessage,
  AssistantMessage,
  AssistantMessageEvent,
  RunDelegateContext,
  Usage,
} from "@eta/core";
import type { HostCalls } from "./host-calls";

type Block = AssistantMessage["content"][number];

type ToolCallProgress = Extract<Event, { kind: "tool_call_progress" }>;

type TaskEvent = Extract<
  Event,
  { kind: "task_started" | "task_updated" | "task_ended" }
>;

type ToolResultContent = Extract<
  AgentMessage,
  { role: "toolResult" }
>["content"];

/** One step a runtime's subagent took inside a root call: a tool it ran, or what it said. */
export type OarChildStep =
  | {
      kind: "tool";
      id: string;
      name: string;
      input?: string;
      status: "running" | "completed" | "failed";
      output?: string;
      outputTruncated?: true;
      exitCode?: number | null;
    }
  | { kind: "text"; text: string };

type ChildToolStep = Extract<OarChildStep, { kind: "tool" }>;

/** The task the runtime tracked for a root call: a subagent, a background command. */
export interface OarRuntimeTask {
  type: string;
  nativeType?: string;
  description?: string;
  background?: boolean;
  status?: string;
  summary?: string;
  outputFile?: string;
}

/** What a root call's tool result carries beside its content; absent when there is nothing. */
export interface OarToolResultDetails {
  exitCode?: number | null;
  children?: OarChildStep[];
  runtimeTask?: OarRuntimeTask;
  other?: unknown[];
}

/** A subagent can run long; the run log needs its shape, not every step or every byte. */
const MAX_CHILD_STEPS = 200;
const MAX_CHILD_OUTPUT = 4000;

interface OpenMessage {
  turnId: string;
  message: AssistantMessage;
  /** The runtime's id for the message, once it has named one. */
  nativeId: string | undefined;
  /** Raw argument text streamed so far, per call. */
  rawInput: Map<string, string>;
}

interface PendingCall {
  name: string;
  args: Record<string, unknown>;
  turnId: string;
  startedAt: number;
  /** What the call has printed so far, for its progress. */
  output?: string;
  /** The steps the runtime's subagent took inside this call, deeper subagents flattened in. */
  children: OarChildStep[];
  runtimeTask?: OarRuntimeTask;
}

/** What the translator needs from the run: where to say things, and who is talking. */
export interface TranslatorTarget {
  readonly runId: string;
  readonly emit: RunDelegateContext["emit"];
  readonly push: RunDelegateContext["push"];
  readonly noteTurn: RunDelegateContext["noteTurn"];
}

export interface TranslatorIdentity {
  /** The runtime, as the message's provider (`claude`, `codex`, ...). */
  provider: string;
  /** The model asked for, until the runtime reports the one in effect. */
  model: string;
}

export function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** What the running total grew by: the usage of whatever happened in between. */
export function usageBetween(
  before: TokenTotals | undefined,
  after: TokenTotals | undefined,
): Usage {
  if (after === undefined) return emptyUsage();
  const grew = (key: keyof TokenTotals): number =>
    Math.max(0, (after[key] ?? 0) - (before?.[key] ?? 0));
  const cacheRead = grew("cacheRead");
  const cacheWrite = grew("cacheWrite");
  // oar counts cache reads and writes as part of input; eta counts them beside it.
  const input = Math.max(0, grew("input") - cacheRead - cacheWrite);
  const output = grew("output");
  return {
    ...emptyUsage(),
    input,
    output,
    cacheRead,
    cacheWrite,
    ...(after.reasoning === undefined ? {} : { reasoning: grew("reasoning") }),
    totalTokens: input + output + cacheRead + cacheWrite,
  };
}

/** A call's arguments as an object: JSON when the runtime gave JSON, its words otherwise. */
export function argumentsOf(
  input: string | undefined,
): Record<string, unknown> {
  if (input === undefined || input.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(input);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
  } catch {}
  return { input };
}

/**
 * A tool result's parts as a tool-result message's content. A part oar does not recognize stays
 * in the content as its JSON too, so search and a model replaying the transcript still see it.
 */
function resultContent(
  parts: readonly ToolOutputPart[] | undefined,
): ToolResultContent {
  const content: ToolResultContent = [];
  for (const part of parts ?? []) {
    if (part.type === "text") content.push({ type: "text", text: part.text });
    else if (part.type === "image")
      content.push({
        type: "image",
        data: part.data,
        mimeType: part.mediaType,
      });
    else content.push({ type: "text", text: JSON.stringify(part) });
  }
  return content;
}

export class Translator {
  readonly #target: TranslatorTarget;
  readonly #identity: TranslatorIdentity;
  readonly #calls: HostCalls;
  #open: OpenMessage | undefined;
  readonly #pending = new Map<string, PendingCall>();
  /** The root call each runtime task belongs to, until that call's result is written. */
  readonly #tasks = new Map<string, string>();
  /** The running total the last message was charged up to. */
  #charged: TokenTotals | undefined;
  /** The running total the runtime reported last. */
  #reported: TokenTotals | undefined;
  #model: string;

  constructor(
    target: TranslatorTarget,
    identity: TranslatorIdentity,
    /** The total charged before this run: usage is counted from the session's opening. */
    charged: TokenTotals | undefined,
    /** The host's tools, for the calls that are theirs. */
    calls: HostCalls,
  ) {
    this.#target = target;
    this.#identity = identity;
    this.#calls = calls;
    this.#model = identity.model;
    this.#charged = charged;
    this.#reported = charged;
  }

  /** The total charged so far, for the next run of the same runtime session to start from. */
  get charged(): TokenTotals | undefined {
    return this.#charged;
  }

  see(event: Event): void {
    // A task names the call that started it; claude reports it from the root agent, but a
    // subagent's own task would come under its path, so the call decides, not the path.
    if (
      event.kind === "task_started" ||
      event.kind === "task_updated" ||
      event.kind === "task_ended"
    ) {
      this.#task(event);
      return;
    }
    if (event.agentPath.length > 0) {
      this.#seeChild(event);
      return;
    }
    switch (event.kind) {
      case "text_delta":
        this.#text(event.text, event.messageId);
        break;
      case "reasoning":
        if (event.content.kind === "text")
          this.#thinking(event.content.text, event.messageId);
        else if (event.content.kind === "redacted")
          this.#thinking("", event.messageId, true);
        break;
      case "tool_call_started":
        this.#callStarted(event.callId, event.tool, event.input);
        break;
      case "tool_call_input_delta":
        this.#callInputDelta(event.callId, event.delta);
        break;
      case "tool_call_input":
        this.#callInput(event.callId, event.input);
        break;
      case "tool_call_ended":
        this.#callEnded(
          event.callId,
          event.content,
          event.result === "failed",
          event.exitCode,
        );
        break;
      case "tool_call_progress":
        this.#progress(event.callId, event);
        break;
      case "usage":
        if (event.usage.tokens !== undefined)
          this.#reported = event.usage.tokens;
        break;
      case "model":
        this.#model = event.model;
        break;
      default:
        break;
    }
  }

  /**
   * The runtime's turn ended: the message in flight ends with it. A call that never came back
   * gets a result that says so, or the transcript would hold a call nobody answered.
   */
  finish(outcome: "completed" | "aborted" | "failed", error?: string): void {
    this.#close(
      outcome === "aborted"
        ? "aborted"
        : outcome === "failed"
          ? "error"
          : "stop",
      error,
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
                : "The runtime reported no result for this call.",
          },
        ],
        true,
      );
    }
  }

  #ensure(nativeId: string | undefined): OpenMessage {
    const open = this.#open;
    if (open !== undefined) {
      // A message under another id is the runtime's next message, not more of this one.
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
      api: `oar-${this.#identity.provider}`,
      provider: this.#identity.provider,
      model: this.#model,
      usage: emptyUsage(),
      stopReason: "stop",
      timestamp: Date.now(),
    };
    this.#open = { turnId, message, nativeId, rawInput: new Map() };
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
    const open = this.#ensure(nativeId);
    const blocks = open.message.content;
    let index = blocks.length - 1;
    const last = blocks[index];
    if (last?.type !== "text") {
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

  #thinking(
    text: string,
    nativeId: string | undefined,
    redacted = false,
  ): void {
    const open = this.#ensure(nativeId);
    const blocks = open.message.content;
    let index = blocks.length - 1;
    const last = blocks[index];
    if (last?.type !== "thinking" || redacted) {
      blocks.push({
        type: "thinking",
        thinking: "",
        ...(redacted ? { redacted: true } : {}),
      });
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

  #callStarted(callId: string, tool: string, input: string | undefined): void {
    const open = this.#ensure(undefined);
    const args = argumentsOf(input);
    const name = this.#calls.hostTool(callId, tool) ?? tool;
    open.message.content.push({
      type: "toolCall",
      id: callId,
      name,
      arguments: args,
    });
    this.#pending.set(callId, {
      name,
      args,
      turnId: open.turnId,
      startedAt: Date.now(),
      children: [],
    });
    this.#update({
      type: "toolcall_start",
      contentIndex: open.message.content.length - 1,
      partial: open.message,
    });
  }

  #callIndex(callId: string): number {
    return (
      this.#open?.message.content.findIndex(
        (block) => block.type === "toolCall" && block.id === callId,
      ) ?? -1
    );
  }

  #callInputDelta(callId: string, delta: string): void {
    const open = this.#open;
    const index = this.#callIndex(callId);
    if (open === undefined || index < 0) return;
    open.rawInput.set(callId, `${open.rawInput.get(callId) ?? ""}${delta}`);
    this.#update({
      type: "toolcall_delta",
      contentIndex: index,
      delta,
      partial: open.message,
    });
  }

  #callInput(callId: string, input: string): void {
    const args = argumentsOf(input);
    const pending = this.#pending.get(callId);
    if (pending !== undefined) pending.args = args;
    const open = this.#open;
    const index = this.#callIndex(callId);
    if (open === undefined || index < 0) return;
    const block = open.message.content[index] as Extract<
      Block,
      { type: "toolCall" }
    >;
    block.arguments = args;
    this.#update({
      type: "toolcall_end",
      contentIndex: index,
      toolCall: structuredClone(block),
      partial: open.message,
    });
  }

  #callEnded(
    callId: string,
    content: readonly ToolOutputPart[] | undefined,
    failed: boolean,
    exitCode: number | null | undefined,
  ): void {
    // The call came back: the message that made it is over.
    if (this.#callIndex(callId) >= 0) this.#close("toolUse");
    const call = this.#pending.get(callId);
    if (call === undefined) return;
    const other = (content ?? []).flatMap((part) =>
      part.type === "other" ? [part.value] : [],
    );
    this.#result(callId, call, resultContent(content), failed, {
      ...this.#calls.take(call.name, call.args, content ?? []),
      ...(exitCode === undefined ? {} : { exitCode }),
      ...(other.length === 0 ? {} : { other }),
    });
  }

  #result(
    callId: string,
    call: PendingCall,
    content: ToolResultContent,
    isError: boolean,
    reported: Pick<OarToolResultDetails, "exitCode" | "other"> &
      Record<string, unknown> = {},
  ): void {
    this.#pending.delete(callId);
    // The result is written once. What a task reports after it (a background command's end, a
    // subagent that keeps going) has nowhere to land, so the task is let go here and its later
    // updates are dropped.
    for (const [taskId, owner] of this.#tasks)
      if (owner === callId) this.#tasks.delete(taskId);
    const details: OarToolResultDetails & Record<string, unknown> = {
      ...reported,
      ...(call.children.length === 0 ? {} : { children: call.children }),
      ...(call.runtimeTask === undefined
        ? {}
        : { runtimeTask: call.runtimeTask }),
    };
    const detailed = Object.keys(details).length === 0 ? {} : { details };
    const { runId, emit, push } = this.#target;
    const result = { content, ...detailed, isError };
    emit("tool:end", {
      runId,
      turnId: call.turnId,
      toolCallId: callId,
      toolName: call.name,
      result,
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

  /**
   * A runtime task, kept on the root call that started it. A task under any other call (one a
   * subagent made) is left out, and so is ambient work the runtime does for itself.
   */
  #task(event: TaskEvent): void {
    if (event.kind === "task_started") {
      if (event.ambient === true || event.toolCallId === undefined) return;
      const call = this.#pending.get(event.toolCallId);
      if (call === undefined) return;
      this.#tasks.set(event.taskId, event.toolCallId);
      call.runtimeTask = {
        type: event.taskType,
        ...(event.nativeType === undefined
          ? {}
          : { nativeType: event.nativeType }),
        ...(event.description === undefined
          ? {}
          : { description: event.description }),
        ...(event.background === undefined
          ? {}
          : { background: event.background }),
      };
      return;
    }
    const owner = this.#tasks.get(event.taskId);
    const task =
      owner === undefined ? undefined : this.#pending.get(owner)?.runtimeTask;
    if (task === undefined) return;
    if (event.kind === "task_updated") {
      if (event.status !== undefined) task.status = event.status;
      if (event.background !== undefined) task.background = event.background;
      if (event.description !== undefined) task.description = event.description;
      return;
    }
    task.status = event.status;
    if (event.summary !== undefined) task.summary = event.summary;
    if (event.outputFile !== undefined) task.outputFile = event.outputFile;
  }

  /** A running call's output so far: replaced by `output`, grown by `outputDelta`. */
  #progress(callId: string, progress: ToolCallProgress): void {
    const call = this.#pending.get(callId);
    if (call === undefined) return;
    call.output =
      (progress.output ?? call.output ?? "") + (progress.outputDelta ?? "");
    this.#target.emit("tool:update", {
      runId: this.#target.runId,
      turnId: call.turnId,
      toolCallId: callId,
      toolName: call.name,
      partialResult: { content: [{ type: "text", text: call.output }] },
    });
  }

  /**
   * A subagent's fact, kept as a step of the root call it works inside; a deeper subagent's
   * flattens onto the same root. Its tool calls are also told as progress of that call, for
   * whoever watches it run.
   */
  #seeChild(event: Event): void {
    const parent = event.agentPath[0];
    const call = parent === undefined ? undefined : this.#pending.get(parent);
    if (parent === undefined || call === undefined) return;
    const steps = call.children;
    const add = (step: OarChildStep): void => {
      if (steps.length < MAX_CHILD_STEPS) steps.push(step);
    };
    const toolStep = (id: string): ChildToolStep | undefined => {
      for (let i = steps.length - 1; i >= 0; i--) {
        const step = steps[i]!;
        if (step.kind === "tool" && step.id === id) return step;
      }
      return undefined;
    };
    switch (event.kind) {
      case "tool_call_started": {
        const name =
          this.#calls.hostTool(event.callId, event.tool) ?? event.tool;
        add({
          kind: "tool",
          id: event.callId,
          name,
          ...(event.input === undefined ? {} : { input: event.input }),
          status: "running",
        });
        this.#target.emit("tool:update", {
          runId: this.#target.runId,
          turnId: call.turnId,
          toolCallId: parent,
          toolName: call.name,
          partialResult: {
            content: [
              {
                type: "text",
                text: `→ ${name}${event.input === undefined ? "" : ` ${event.input}`}`,
              },
            ],
          },
        });
        break;
      }
      case "tool_call_input": {
        const step = toolStep(event.callId);
        if (step !== undefined) step.input = event.input;
        break;
      }
      case "tool_call_input_delta": {
        const step = toolStep(event.callId);
        if (step !== undefined)
          step.input = `${step.input ?? ""}${event.delta}`;
        break;
      }
      case "tool_call_ended": {
        const step = toolStep(event.callId);
        if (step === undefined) break;
        // A subagent's call to a host tool spends its answer; a step has no details to put it on.
        this.#calls.take(
          step.name,
          argumentsOf(step.input),
          event.content ?? [],
        );
        step.status = event.result === "failed" ? "failed" : "completed";
        const output = (event.content ?? [])
          .flatMap((part) => (part.type === "text" ? [part.text] : []))
          .join("\n");
        if (output.length > MAX_CHILD_OUTPUT) {
          step.output = output.slice(0, MAX_CHILD_OUTPUT);
          step.outputTruncated = true;
        } else if (output !== "") step.output = output;
        if (event.exitCode !== undefined) step.exitCode = event.exitCode;
        break;
      }
      case "text_delta": {
        const last = steps.at(-1);
        if (last?.kind === "text") last.text += event.text;
        else add({ kind: "text", text: event.text });
        break;
      }
      default:
        break;
    }
  }

  #close(
    stopReason: AssistantMessage["stopReason"],
    errorMessage?: string,
  ): void {
    const open = this.#open;
    if (open === undefined) return;
    this.#open = undefined;
    const { runId, emit, push } = this.#target;
    const message = open.message;
    message.model = this.#model;
    message.stopReason =
      stopReason === "stop" &&
      message.content.some((block) => block.type === "toolCall")
        ? "toolUse"
        : stopReason;
    if (errorMessage !== undefined) message.errorMessage = errorMessage;
    message.usage = usageBetween(this.#charged, this.#reported);
    this.#charged = this.#reported;
    this.#update(
      message.stopReason === "error" || message.stopReason === "aborted"
        ? { type: "error", reason: message.stopReason, error: message }
        : {
            type: "done",
            reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
            message,
          },
    );
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
      const pending = this.#pending.get(block.id);
      emit("tool:start", {
        runId,
        turnId: open.turnId,
        toolCallId: block.id,
        toolName: block.name,
        args: pending?.args ?? block.arguments,
      });
    }
  }
}
