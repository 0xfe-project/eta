// Member sessions on the wire: `sessions.<id>` is where the things the timeline does not hold live
// (a reply's words as it writes them, its tool calls). See apps/web/src/queries/sessions.ts.

import type {
  AgentMessage,
  TranscriptSection,
  ViewCore,
  ViewMessageRow,
} from "@eta/client-contracts";
import type { LogBlock, RunBlock } from "./run";
import { cleanup, effect, signal } from "nsh";
import { wire } from "../../app/session";
import { call } from "../../wire/target";
import { logBlocks, runBlocks } from "./run";

const targetOf = (sessionId: string) => `sessions.${sessionId}`;

/** Sessions asked to open: a session is only a target while it is open. */
const opened = new Set<string>();

/** The sessions a screen reads, kept open and live for as long as it lives. */
export class SessionWatch {
  /** The message each session is streaming, by session: the view only says when one starts. */
  private readonly streamed = signal<Record<string, AgentMessage | undefined>>(
    {},
  );
  /** What each running call has printed so far, by session and call. */
  private readonly printed = signal<Record<string, Record<string, string>>>({});
  private readonly held = new Map<string, () => void>();

  /** Hold exactly these sessions: new ones open, ones gone are released. */
  sync(ids: readonly string[]): void {
    for (const id of ids) if (!this.held.has(id)) this.open(id);
    for (const [id, release] of this.held) {
      if (ids.includes(id)) continue;
      release();
      this.held.delete(id);
    }
  }

  close(): void {
    for (const release of this.held.values()) release();
    this.held.clear();
  }

  private open(id: string): void {
    const connection = wire();
    let released = false;
    let release: (() => void) | undefined;
    const attach = () => {
      if (!released) release = connection.subscribe(targetOf(id));
    };
    if (opened.has(id)) attach();
    else
      void connection
        .call("sessions", "resync", { session: id })
        .then(() => opened.add(id))
        .catch(() => undefined)
        .finally(attach);
    let latest: AgentMessage | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let printTimer: ReturnType<typeof setTimeout> | undefined;
    const outputs: Record<string, string> = {};
    // A token is an event; the screen draws a few times a second, not per token.
    const showWords = () => {
      timer ??= setTimeout(() => {
        timer = undefined;
        this.streamed.update((all) => ({ ...all, [id]: latest }));
      }, 40);
    };
    const showPrinted = () => {
      printTimer ??= setTimeout(() => {
        printTimer = undefined;
        this.printed.update((all) => ({ ...all, [id]: { ...outputs } }));
      }, 100);
    };
    const off = connection.onEvent(targetOf(id), ({ name, data }) => {
      const update = data as
        | {
            message?: AgentMessage;
            toolCallId?: unknown;
            partialResult?: { content?: { type?: string; text?: string }[] };
          }
        | undefined;
      if (name === "message:update") {
        latest = update?.message;
        showWords();
      } else if (
        name === "turn:run-start" ||
        name === "generation:interrupted"
      ) {
        latest = undefined;
        showWords();
      } else if (name === "turn:run-end") {
        latest = undefined;
        showWords();
        for (const key of Object.keys(outputs)) delete outputs[key];
        showPrinted();
      } else if (
        name === "tool:update" &&
        typeof update?.toolCallId === "string"
      ) {
        const text = (update.partialResult?.content ?? [])
          .filter((part) => part.type === "text")
          .map((part) => part.text ?? "")
          .join("\n");
        if (text === "") return;
        outputs[update.toolCallId] = text;
        showPrinted();
      } else if (
        name === "tool:end" &&
        typeof update?.toolCallId === "string"
      ) {
        delete outputs[update.toolCallId];
        showPrinted();
      }
    });
    this.held.set(id, () => {
      released = true;
      release?.();
      off();
      clearTimeout(timer);
      clearTimeout(printTimer);
    });
  }

  rows(id: string): readonly ViewMessageRow[] {
    return (
      wire().section<TranscriptSection>(targetOf(id), "transcript")?.messages ??
      []
    );
  }

  /** The run in flight on a session, as blocks to draw. See `useRunBlocks`. Reactive. */
  blocks(id: string, runFrom: number | undefined): RunBlock[] {
    const rows = this.rows(id);
    const behind = runFrom !== undefined && (rows.at(-1)?.seq ?? 0) <= runFrom;
    const core = wire().section<ViewCore>(targetOf(id), "core");
    const streaming =
      this.streamed()[id] ?? (behind ? undefined : core?.streaming);
    return runBlocks(rows, streaming, runFrom);
  }

  /** The session's whole log, for a task run. Reactive. */
  log(id: string, older: readonly ViewMessageRow[]): LogBlock[] {
    const window = this.rows(id);
    const seen = new Map(older.map((row) => [row.entryId, row]));
    for (const row of window) seen.set(row.entryId, row);
    const rows = [...seen.values()].sort((a, b) => a.seq - b.seq);
    const core = wire().section<ViewCore>(targetOf(id), "core");
    return logBlocks(rows, this.streamed()[id] ?? core?.streaming);
  }

  /** How many messages exist before the window. Reactive. */
  before(id: string): number {
    return (
      wire().section<TranscriptSection>(targetOf(id), "transcript")
        ?.messagesBefore ?? 0
    );
  }

  /** The view has come. Reactive. */
  loaded(id: string): boolean {
    return wire().target(targetOf(id)) !== undefined;
  }

  /** The host has no such session. Reactive. */
  missing(id: string): boolean {
    return wire().isMissing(targetOf(id));
  }

  /** What a running call has printed so far. Reactive. */
  progress(id: string, callId: string): string | undefined {
    return this.printed()[id]?.[callId];
  }
}

/** A `SessionWatch` for the calling component, following a reactive list of sessions. */
export function useSessions(ids: () => readonly string[]): SessionWatch {
  const watch = new SessionWatch();
  effect(() => watch.sync(ids()));
  cleanup(() => watch.close());
  return watch;
}
