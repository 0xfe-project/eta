/**
 * Repairing a transcript the provider will not accept.
 *
 * A tool call and its result are one fact in two entries, and a process can die
 * between them: the assistant message that issued the call never lands, or it
 * lands and the result never does. Either half left alone makes every later
 * request malformed, and providers say so at the door — DeepSeek, for one:
 *
 *   HTTP 400 Messages with role 'tool' must be a response to a preceding
 *            message with 'tool_calls'
 *   HTTP 400 An assistant message with 'tool_calls' must be followed by tool
 *            messages responding to each 'tool_call_id'
 *
 * A 400 arrives before the stream starts, so the run fails with nothing the
 * user can act on, on every message, for ever. The only way out is to repair
 * the transcript — and the repair has to be in the branch the journal replays,
 * not a filter over the request, otherwise the next open rebuilds the same
 * broken state and the session is wedged again.
 *
 * Two rules the repair will not bend:
 *
 * - **A tool is never run again.** The result that is missing may have had
 *   effects; a placeholder that says "unknown, do not assume success" is the
 *   honest answer, and re-running `bash` to find out is not.
 * - **A result nobody asked for is dropped, not kept.** There is no message it
 *   can attach to, and inventing a call for it would be inventing history.
 *
 * How it is expressed: `EntryGraph` has no remove, and the journal is
 * append-only, so a repair is a rollback to the last entry before the damage
 * and a re-append of everything that survives it. The superseded entries leave
 * the branch path — which is the transcript the model reads, and the one a
 * reload reproduces — and stay in the file as history, exactly as a rollback's
 * entries do. Nothing is destroyed; the branch moves.
 *
 * Messages before the last `compaction` or `branch_summary` are not in the
 * transcript at all (both stand in for the history they replaced), so they are
 * not inspected: a broken pair back there costs nothing, and "repairing" it
 * would mean touching history the model never sees.
 */

import type {
  AgentMessage,
  AssistantMessage,
  Message,
  ToolCall,
} from "@eta/core";
import type {
  Entry,
  MessageEntry,
  NewEntry,
  SessionLog,
} from "@eta/core/session";
import type { ImageLimits } from "./image-limits";
import {
  checkBase64Image,
  DEFAULT_IMAGE_LIMITS,
  describeImageProblem,
} from "./image-limits";
import { base64ByteLength } from "./tools/image";

/** A result message, as the transcript holds it. */
type ToolResultMessage = Extract<Message, { role: "toolResult" }>;

/** What the model is told when a call has no result and never will. */
const INTERRUPTED_TOOL_RESULT =
  "No result: the process ended while this call was running, so whether it " +
  "took effect is unknown. Do not assume it succeeded — check before relying " +
  "on it, and repeat the work deliberately if it needs repeating.";

/** What a repair did. Empty means the transcript was already valid. */
export interface TranscriptRepair {
  /** Tool results dropped: the call they answer is not in the transcript. */
  droppedResults: { entryId: string; toolCallId: string; toolName: string }[];
  /** Tool calls padded with a placeholder: nothing ever answered them. */
  paddedCalls: { entryId: string; toolCallId: string; toolName: string }[];
  /** Images taken out of history: the model cannot accept them. */
  degradedImages: {
    entryId: string;
    mimeType: string;
    bytes: number;
    detail: string;
  }[];
}

/** One step of the repaired branch, in transcript order. */
type Step =
  | { kind: "keep"; entry: Entry }
  | { kind: "drop"; entry: MessageEntry }
  | { kind: "pad"; entry: MessageEntry; toolCallId: string; toolName: string }
  | {
      kind: "degrade";
      entry: MessageEntry;
      message: AgentMessage;
      images: { mimeType: string; bytes: number; detail: string }[];
    };

function isToolCall(part: unknown): part is ToolCall {
  return (
    typeof part === "object" &&
    part !== null &&
    (part as { type?: unknown }).type === "toolCall"
  );
}

/**
 * The branch, planned as it should read.
 *
 * A scope is one assistant message's tool calls and the results that answer
 * them. It closes at the next assistant message, at the first message that is
 * not a result, or at the end of the transcript — and whatever is still open
 * then can never be answered, so it is padded there.
 */
function planRepair(path: readonly Entry[], limits: ImageLimits): Step[] {
  const steps: Step[] = [];
  /** The calls of the current scope that nothing has answered yet. */
  let open = new Map<string, string>();

  const closeScope = (owner: MessageEntry | undefined): void => {
    if (open.size === 0) return;
    for (const [toolCallId, toolName] of open)
      steps.push({
        kind: "pad",
        entry: owner as MessageEntry,
        toolCallId,
        toolName,
      });
    open = new Map();
  };

  // A message carrying an image the model cannot take is kept, with the picture
  // replaced by a line saying what it was. Dropping the message outright would
  // drop a tool result its call is waiting for, and keeping the picture wedges
  // every later request; there is no third option.
  const keepMessage = (entry: MessageEntry): void => {
    const degraded = degradeImages(entry.message, limits);
    if (degraded === undefined) {
      steps.push({ kind: "keep", entry });
      return;
    }
    steps.push({
      kind: "degrade",
      entry,
      message: degraded.message,
      images: degraded.images,
    });
  };

  let scopeOwner: MessageEntry | undefined;
  for (const entry of path) {
    // A compaction or a branch summary stands in for everything before it: the
    // messages on the other side of it are not part of the transcript, so no
    // pairing there can break a request.
    if (entry.type === "compaction" || entry.type === "branch_summary") {
      open = new Map();
      scopeOwner = undefined;
      steps.push({ kind: "keep", entry });
      continue;
    }
    if (entry.type !== "message") {
      steps.push({ kind: "keep", entry });
      continue;
    }
    const message = entry.message;
    if (message.role === "assistant") {
      closeScope(scopeOwner);
      const calls = (message as AssistantMessage).content.filter(isToolCall);
      for (const call of calls) open.set(call.id, call.name);
      scopeOwner = entry;
      keepMessage(entry);
      continue;
    }
    if (message.role === "toolResult") {
      const result = message as ToolResultMessage;
      if (!open.has(result.toolCallId)) {
        steps.push({ kind: "drop", entry });
        continue;
      }
      open.delete(result.toolCallId);
      keepMessage(entry);
      continue;
    }
    // A user message: whatever was open can never be answered now, and a result
    // arriving after it would be a result out of its scope.
    closeScope(scopeOwner);
    scopeOwner = undefined;
    keepMessage(entry);
  }
  closeScope(scopeOwner);
  return steps;
}

/**
 * The same message with every image the model cannot take replaced by a note.
 *
 * `undefined` when there is nothing to change — the common case, and the one
 * that must leave the message exactly as it was. The note keeps the fact that
 * an image was there, because a model that is told nothing about it will act
 * as if the tool result was always a sentence.
 */
function degradeImages(
  message: AgentMessage,
  limits: ImageLimits,
):
  | {
      message: AgentMessage;
      images: { mimeType: string; bytes: number; detail: string }[];
    }
  | undefined {
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const images: { mimeType: string; bytes: number; detail: string }[] = [];
  const parts = content.map((part: unknown) => {
    if (!isImagePart(part)) return part;
    const problem = checkBase64Image(part.data, part.mimeType, limits);
    if (problem === undefined) return part;
    const bytes = base64ByteLength(part.data);
    images.push({ mimeType: part.mimeType, bytes, detail: problem.detail });
    return {
      type: "text" as const,
      text:
        "[An image was here and was removed from the history: " +
        `${describeImageProblem(part.mimeType, bytes, problem)}. ` +
        "A request carrying it is refused by the provider, so it could not " +
        "stay. Read a smaller version if you need to see it again.]",
    };
  });
  if (images.length === 0) return undefined;
  return {
    message: { ...message, content: parts } as AgentMessage,
    images,
  };
}

function isImagePart(
  part: unknown,
): part is { type: "image"; data: string; mimeType: string } {
  if (typeof part !== "object" || part === null) return false;
  const candidate = part as {
    type?: unknown;
    data?: unknown;
    mimeType?: unknown;
  };
  return (
    candidate.type === "image" &&
    typeof candidate.data === "string" &&
    typeof candidate.mimeType === "string"
  );
}

/** A message entry re-appended under a fresh id, keeping what it carried. */
function reappendable(entry: MessageEntry): NewEntry<MessageEntry> {
  const { id: _id, parentId: _parentId, seq: _seq, ...rest } = entry;
  // `parentId` stays absent on purpose: an append belongs on the tip, and the
  // tip is wherever the previous re-appended entry left it.
  return rest as unknown as NewEntry<MessageEntry>;
}

function placeholder(toolCallId: string, toolName: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text: INTERRUPTED_TOOL_RESULT }],
    isError: true,
    timestamp: Date.now(),
  };
}

/**
 * Repair this journal's branch so the transcript is one a provider accepts.
 *
 * Returns what was done, or `undefined` when there was nothing to do — the
 * common case, and the one that must leave the journal untouched.
 */
export async function repairTranscript(
  log: SessionLog,
  limits: ImageLimits = DEFAULT_IMAGE_LIMITS,
): Promise<TranscriptRepair | undefined> {
  const steps = planRepair(log.graph.pathOldestFirst(), limits);
  const firstBroken = steps.findIndex(
    (step) =>
      step.kind === "drop" || step.kind === "pad" || step.kind === "degrade",
  );
  if (firstBroken === -1) return undefined;

  const repair: TranscriptRepair = {
    droppedResults: [],
    paddedCalls: [],
    degradedImages: [],
  };

  // Cut the branch just before the damage, then replay the rest of it. The
  // entries from here on are re-recorded, so their ids are new: the superseded
  // ones keep their place in the file, off the branch.
  let cut: Entry | undefined;
  for (let index = firstBroken - 1; index >= 0; index -= 1) {
    const step = steps[index]!;
    if (step.kind === "keep") {
      cut = step.entry;
      break;
    }
  }
  if (cut === undefined) {
    log.graph.setTip(null);
    await log.commit();
  } else {
    const result = await log.rollback(cut.id);
    // The cut was taken from this branch a moment ago; only a journal mutated
    // underneath us could make it unknown, and then the honest answer is to
    // leave the session as it is rather than replay onto a guess.
    if (!result.ok) return undefined;
  }

  for (const step of steps.slice(firstBroken)) {
    if (step.kind === "drop") {
      repair.droppedResults.push({
        entryId: step.entry.id,
        toolCallId: (step.entry.message as ToolResultMessage).toolCallId,
        toolName: (step.entry.message as ToolResultMessage).toolName,
      });
      continue;
    }
    if (step.kind === "pad") {
      log.recordMessage(placeholder(step.toolCallId, step.toolName));
      repair.paddedCalls.push({
        entryId: step.entry.id,
        toolCallId: step.toolCallId,
        toolName: step.toolName,
      });
      continue;
    }
    if (step.kind === "degrade") {
      log.record({
        ...reappendable(step.entry),
        message: step.message,
      } as NewEntry<MessageEntry>);
      for (const image of step.images)
        repair.degradedImages.push({ entryId: step.entry.id, ...image });
      continue;
    }
    if (step.entry.type === "message") {
      // `terminate` rides along in `rest`; it is the entry's own fact.
      log.record(reappendable(step.entry));
      continue;
    }
    const { id: _id, parentId: _parentId, seq: _seq, ...rest } = step.entry;
    log.record(rest as unknown as NewEntry<Entry>);
  }
  await log.commit();
  return repair;
}

/** One line a host can log, so a self-healed session is not a silent one. */
export function describeRepair(repair: TranscriptRepair): string {
  const parts: string[] = [];
  if (repair.droppedResults.length > 0) {
    const ids = repair.droppedResults.map((row) => row.toolCallId).join(", ");
    parts.push(
      `dropped ${repair.droppedResults.length} tool result(s) no call asked for (${ids})`,
    );
  }
  if (repair.paddedCalls.length > 0) {
    const ids = repair.paddedCalls.map((row) => row.toolCallId).join(", ");
    parts.push(
      `answered ${repair.paddedCalls.length} interrupted tool call(s) with a placeholder (${ids})`,
    );
  }
  if (repair.degradedImages.length > 0) {
    const images = repair.degradedImages
      .map((row) => `${row.mimeType} (${row.detail})`)
      .join("; ");
    parts.push(
      `removed ${repair.degradedImages.length} image(s) the model cannot accept (${images})`,
    );
  }
  return parts.join("; ");
}
