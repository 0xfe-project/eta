/**
 * The view: what a UI can see about a session, assembled from contributions
 * (SERVER-REFACTOR.md §3).
 *
 * The shape this replaces — one struct with every field the UI ever needed — had the
 * floor enumerate the sections, which meant a plugin that wanted a panel had to change
 * the floor. Here the container is three things and nothing else:
 *
 * ```
 * { core, sections: Record<name, unknown>, revisions: Record<name, string> }
 * ```
 *
 * - **Whoever owns state contributes it.** `transcript` comes from journaling, `goal`
 *   from the goal primitive, `git` from the git plugin. Built-in and plugin sections are
 *   not different kinds of thing.
 * - **A contribution carries its own revision** — a cheap signature of its own state. A
 *   section whose revision did not move is simply absent from the next frame, so "which
 *   fields are heavy" never has to be decided by anyone: the transcript appears exactly
 *   when the journal moves and not otherwise.
 * - **A contribution is an effect.** `contribute()` returns a disposer, so a plugin that
 *   unloads takes its section with it and the client sees it disappear.
 *
 * This file returns plain data — no wire types, no frame shapes. The server maps it to
 * the wire, and a structural test there keeps the two honest.
 */

import type {
  AgentMessage,
  GoalState,
  KernelConfig,
  StoredTask,
} from "@eta/core";
import type { Entry } from "@eta/core/session";
import type { Context } from "cordis";
import { kernelOn } from "@eta/core";
import { Service } from "cordis";

/** The session's own slice: who it is, and whether something is happening right now. */
export interface ViewCore {
  session: string;
  cwd?: string | undefined;
  running: boolean;
  /** The in-flight assistant message while a run streams; absent once committed. */
  streaming?: AgentMessage | undefined;
}

/**
 * How much of a message has been written so far, as a number that only grows while it streams.
 * It is part of the core's revision, so a client that subscribes mid-stream is sent the text so
 * far and a client already there is sent each step (the frame pacer bounds how many).
 */
export function streamedSize(message: AgentMessage | undefined): string {
  if (message === undefined) return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return String(content.length);
  if (!Array.isArray(content)) return "0";
  let size = content.length;
  for (const block of content as Record<string, unknown>[]) {
    for (const key of ["text", "thinking"]) {
      const text = block[key];
      if (typeof text === "string") size += text.length;
    }
    if (block.arguments !== undefined)
      size += JSON.stringify(block.arguments).length;
  }
  return String(size);
}

/** One piece of the view, owned by whoever knows the state. */
export interface ViewContribution<T = unknown> {
  /** The section name. A plugin prefixes its own name (`git`, `ssh.jump`). */
  name: string;
  /** Project the current state. Cheap: it is called on every frame. */
  project: () => T;
  /** A cheap signature of that state: equal means this section did not change. */
  revision: () => string;
}

/**
 * The container, structurally what the protocol's state snapshot is: sections and their
 * revisions, and nothing else. Even the session's own "core" is a section here — a field
 * the container has to know about would be a privilege, and the point is that there are none.
 */
export interface SessionViewSnapshot {
  sections: Record<string, unknown>;
  revisions: Record<string, string>;
}

export interface ViewServiceOptions {
  /** Where the core comes from: the host knows the session's id, cwd and run state. */
  core: () => ViewCore;
  /** Diagnostics: two contributions claiming one name. */
  warn?: ((message: string) => void) | undefined;
}

/**
 * The session's view registry. A service like any other, so it lives on the session's
 * context and dies with it.
 */
export class ViewService extends Service {
  static readonly provide = "view";

  private readonly contributions = new Map<string, ViewContribution>();
  private readonly warn: (message: string) => void;

  constructor(ctx: Context, options: ViewServiceOptions) {
    super(ctx, "view");
    this.warn = options.warn ?? (() => undefined);
    // The session's own identity is a section like any other. It changes on its own (a run
    // starting, a message streaming), so its revision is its own signature, not a counter
    // somebody has to remember to bump.
    this.contribute({
      name: "core",
      project: options.core,
      revision: () => {
        const core = options.core();
        return `${core.session}|${core.running ? 1 : 0}|${streamedSize(core.streaming)}`;
      },
    });
  }

  /**
   * Add a section. Two contributions with one name would make the view ambiguous, so
   * the second is refused rather than silently winning — and the name is the plugin's
   * own, so this is a bug in the plugin, not a collision to resolve.
   */
  contribute<T>(contribution: ViewContribution<T>): () => void {
    if (this.contributions.has(contribution.name)) {
      throw new Error(`view section already contributed: ${contribution.name}`);
    }
    this.contributions.set(contribution.name, contribution as ViewContribution);
    return () => {
      if (
        this.contributions.get(contribution.name) ===
        (contribution as ViewContribution)
      ) {
        this.contributions.delete(contribution.name);
      }
    };
  }

  /** Every section name currently in the view. */
  names(): string[] {
    return [...this.contributions.keys()].sort();
  }

  /**
   * One frame's worth of view.
   *
   * A contribution that throws does not take the frame down with it: its section is
   * reported as an error value and the rest of the view is still sent. A broken plugin
   * panel is not a broken session.
   */
  snapshot(): SessionViewSnapshot {
    const sections: Record<string, unknown> = {};
    const revisions: Record<string, string> = {};
    for (const contribution of this.contributions.values()) {
      try {
        sections[contribution.name] = contribution.project();
        revisions[contribution.name] = contribution.revision();
      } catch (error) {
        this.warn(
          `[eta-harness] view section ${contribution.name} failed: ${String(error)}`,
        );
        sections[contribution.name] = {
          error: error instanceof Error ? error.message : String(error),
        };
        revisions[contribution.name] = `error:${String(error)}`;
      }
    }
    return { sections, revisions };
  }
}

/** A cheap signature for small, plain state: JSON is fine when a section is tiny. */
export function signatureOf(value: unknown): string {
  return (
    JSON.stringify(value, (_key, entry) =>
      typeof entry === "function" ? undefined : entry,
    ) ?? "undefined"
  );
}

/**
 * The message being streamed right now, if any.
 *
 * The runner emits frames rather than holding state, so whoever wants to show a
 * half-written message has to keep the last frame: that is this box. It is cleared when
 * the message lands, because a committed message belongs to the transcript.
 */
export function streamingBox(ctx: Context): {
  current: () => AgentMessage | undefined;
} {
  let current: AgentMessage | undefined;
  kernelOn(ctx)("message:update", (event) => {
    current = event.message;
  });
  kernelOn(ctx)("message:end", () => {
    current = undefined;
  });
  // A thrown-away generation is not a message: nothing of it may stay on screen.
  kernelOn(ctx)("generation:interrupted", () => {
    current = undefined;
  });
  return { current: () => current };
}

/** One row of a visible conversation, with the entry it came from. */
export interface ViewMessageRow {
  entryId: string;
  seq: number;
  at: number;
  message: AgentMessage;
}

/** Are these messages the assistant's thinking, in order? */
export function thinkingRows(messages: readonly AgentMessage[]): string[] {
  const rows: string[] = [];
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content))
      continue;
    for (const block of message.content) {
      const part = block as { type?: string; thinking?: string };
      if (
        part.type === "thinking" &&
        typeof part.thinking === "string" &&
        part.thinking.length > 0
      ) {
        rows.push(part.thinking);
      }
    }
  }
  return rows;
}

/** The text and attachments of a queued message, for the composer's pull-back. */
export function queuedText(message: AgentMessage): {
  text: string;
  images?: { mime: string; dataBase64: string }[];
} {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return { text: content };
  if (!Array.isArray(content)) return { text: "" };
  const images: { mime: string; dataBase64: string }[] = [];
  const text: string[] = [];
  for (const block of content) {
    const part = block as {
      type?: string;
      text?: string;
      mimeType?: string;
      data?: string;
    };
    if (part.type === "text" && typeof part.text === "string")
      text.push(part.text);
    // Attachments ride as attachments: a pull-back restores chips, not base64 text.
    if (
      part.type === "image" &&
      typeof part.mimeType === "string" &&
      typeof part.data === "string"
    ) {
      images.push({ mime: part.mimeType, dataBase64: part.data });
    }
  }
  return { text: text.join("\n"), ...(images.length === 0 ? {} : { images }) };
}

/** How many bytes a base64 string decodes to, without decoding it. */
function base64Bytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

/**
 * The message with its pictures left out: each image part in an array `content` becomes
 * `{ type: "image", mimeType, data: "", bytes }`, and `sessions.image` fetches the bytes when
 * a reader wants them. A screenshot is megabytes of base64 that every snapshot would resend.
 *
 * The journal's message is never touched: a message with pictures is copied, one without
 * is returned as is, so a transcript of plain text allocates nothing.
 */
export function withoutImageData(message: AgentMessage): AgentMessage {
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return message;
  const isPicture = (part: unknown): boolean => {
    const image = part as { type?: unknown; data?: unknown } | null;
    return (
      image?.type === "image" &&
      typeof image.data === "string" &&
      image.data.length > 0
    );
  };
  if (!content.some(isPicture)) return message;
  return {
    ...message,
    content: content.map((part: unknown) => {
      if (!isPicture(part)) return part;
      const image = part as { data: string; mimeType: string };
      return {
        type: "image",
        mimeType: image.mimeType,
        data: "",
        bytes: base64Bytes(image.data),
      };
    }),
  } as AgentMessage;
}

/** The entries a view shows as system rows rather than messages. */
export const SYSTEM_ROW_KINDS = [
  "goal",
  "ask",
  "answer",
  "btw",
  "compaction",
  "merge",
  "run_failed",
] as const;
export type SystemRowKind = (typeof SYSTEM_ROW_KINDS)[number];

/** One system row: an entry the session recorded that is not a message. */
export interface ViewSystemRow {
  entryId: string;
  seq: number;
  at: number;
  kind: SystemRowKind;
  args: Record<string, string>;
}

/** The entry as a system row, or `undefined` when it is not one. */
export function systemRowOf(entry: Entry): ViewSystemRow | undefined {
  if (!(SYSTEM_ROW_KINDS as readonly string[]).includes(entry.type))
    return undefined;
  return {
    entryId: entry.id,
    seq: entry.seq,
    at: entry.timestamp,
    kind: entry.type as SystemRowKind,
    // A failed run is only worth a row if the row says why.
    args:
      entry.type === "run_failed"
        ? { runId: entry.payload.runId, error: entry.payload.error }
        : {},
  };
}

/** How many transcript rows a snapshot keeps; older ones are fetched on demand. */
export const VIEW_MESSAGE_WINDOW = 200;

/** The rows and their sources, as the built-in contributions produce them. */
export interface ViewSources {
  session: string;
  cwd?: string | undefined;
  /** Whether a run is in flight. */
  running: () => boolean;
  /** The message being streamed, if any. */
  streaming: () => AgentMessage | undefined;
  /** Entries on the visible branch, oldest first. */
  entries: () => readonly Entry[];
  /** A counter that moves when the journal gains an entry. */
  entryVersion: () => number;
  /** The branch tip, and how many compactions are behind it. */
  branch: () => { tipId: string | null; compactionEpoch: number };
  /** The session totals, mirrored by the journaling service. */
  usage: () => import("@earendil-works/pi-ai").Usage;
  /** The goal, when there is one. */
  goal: () => GoalState | undefined;
  tasks: () => StoredTask[];
  personaNames: () => string[];
  config: () => KernelConfig;
  /** Queued messages waiting for a run. */
  queue: () => readonly {
    entryId: string;
    kind: string;
    message: AgentMessage;
  }[];
  tools: () => readonly { name: string; description?: string | undefined }[];
  /** KV keys the state tools have set. */
  stateKeys: () => readonly string[];
  tokensPerSec: () => number;
  ask: () => { pending?: unknown; deadline?: number | undefined } | undefined;
  sideThread: () => unknown;
  subagents: () => readonly { id: string; status: string; turns: number }[];
}

/**
 * The standard sections, as contributions.
 *
 * Each one reads from its owner's own public state; none of them decide *whether* to
 * exist — a session without an ask channel has no `ask` section, and that is the
 * server's `ask: true` talking, not a flag here.
 */
export function builtinViewContributions(
  sources: ViewSources,
): ViewContribution[] {
  // The transcript and its siblings come from entries, so they share the entry
  // version: one new message resends all three, and a task edit resends none of them.
  const fromEntries = (): string => String(sources.entryVersion());
  const contributions: ViewContribution[] = [
    {
      name: "transcript",
      project: () => {
        const messages = sources
          .entries()
          .filter(
            (entry): entry is Extract<Entry, { type: "message" }> =>
              entry.type === "message",
          )
          .map<ViewMessageRow>((entry) => ({
            entryId: entry.id,
            seq: entry.seq,
            at: entry.timestamp,
            message: entry.message,
          }));
        const window = messages.slice(-VIEW_MESSAGE_WINDOW);
        return {
          // Pictures stay in the journal; `sessions.image` fetches one on demand.
          messages: window.map((row) => {
            const message = withoutImageData(row.message);
            return message === row.message ? row : { ...row, message };
          }),
          ...(messages.length > window.length
            ? { messagesBefore: messages.length - window.length }
            : {}),
        };
      },
      revision: fromEntries,
    },
    {
      name: "systems",
      project: () => ({
        rows: sources.entries().flatMap((entry) => systemRowOf(entry) ?? []),
      }),
      revision: fromEntries,
    },
    {
      name: "thinking",
      project: () => ({
        rows: thinkingRows(
          sources
            .entries()
            .filter(
              (entry): entry is Extract<Entry, { type: "message" }> =>
                entry.type === "message",
            )
            .map((entry) => entry.message),
        ),
      }),
      revision: fromEntries,
    },
    {
      name: "branch",
      project: () => sources.branch(),
      revision: () => {
        const branch = sources.branch();
        return `${branch.tipId ?? ""}|${branch.compactionEpoch}`;
      },
    },
    {
      name: "usage",
      project: () => sources.usage(),
      revision: () => signatureOf(sources.usage()),
    },
    {
      name: "state",
      project: () => ({ keys: [...sources.stateKeys()].sort() }),
      revision: () => [...sources.stateKeys()].sort().join(","),
    },
    {
      name: "goal",
      project: () => sources.goal(),
      revision: () => signatureOf(sources.goal() ?? null),
    },
    {
      name: "tasks",
      project: () => sources.tasks(),
      revision: () => signatureOf(sources.tasks()),
    },
    {
      name: "personas",
      project: () => sources.personaNames(),
      revision: () => signatureOf(sources.personaNames()),
    },
    {
      name: "model",
      project: () => {
        const config = sources.config();
        return {
          id: `${config.model.provider}:${config.model.modelId}`,
          thinkingLevel: config.thinkingLevel,
        };
      },
      revision: () => {
        const config = sources.config();
        return `${config.model.provider}:${config.model.modelId}|${config.thinkingLevel}`;
      },
    },
    {
      name: "queue",
      project: () => ({
        items: sources.queue().map((item) => ({
          entryId: item.entryId,
          kind: item.kind,
          ...queuedText(item.message),
        })),
      }),
      revision: () =>
        signatureOf(
          sources.queue().map((item) => [item.entryId, item.message]),
        ),
    },
    {
      name: "tools",
      project: () =>
        sources.tools().map((tool) => ({
          name: tool.name,
          description: tool.description ?? "",
        })),
      revision: () => signatureOf(sources.tools().map((tool) => tool.name)),
    },
    {
      name: "metrics",
      project: () => ({ tokensPerSec: sources.tokensPerSec() }),
      // A rate is a live number: it "changes" every frame it is read, which is what
      // makes a run stream frames at all.
      revision: () => sources.tokensPerSec().toFixed(1),
    },
  ];

  if (sources.ask() !== undefined) {
    contributions.push({
      name: "ask",
      project: () => {
        const ask = sources.ask();
        return {
          ...(ask?.pending === undefined ? {} : { pending: ask.pending }),
        };
      },
      revision: () => signatureOf(sources.ask()?.pending ?? null),
    });
  }
  contributions.push({
    name: "sideThread",
    project: () => sources.sideThread(),
    revision: () => signatureOf(sources.sideThread()),
  });
  contributions.push({
    name: "subagents",
    project: () =>
      sources.subagents().map((record) => ({
        id: record.id,
        status: record.status,
        turns: record.turns,
      })),
    revision: () =>
      signatureOf(
        sources
          .subagents()
          .map((record) => [record.id, record.status, record.turns]),
      ),
  });
  return contributions;
}
