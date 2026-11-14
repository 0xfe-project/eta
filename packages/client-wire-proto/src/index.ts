/**
 * The pipe protocol (SERVER-REFACTOR.md §3).
 *
 * This package is the *client's* view of the wire, and the server is a pipe: it carries
 * calls in, and replies, state and events out. There is deliberately no op vocabulary
 * here — no `prompt`, no `session.pin`, no "built-in" anything. What can be called is
 * whatever the running server registered, and `hello` says exactly that.
 *
 * The whole protocol is four frames in and five out:
 *
 * ```
 * in : call { target, action, args?, requestId? }   subscribe | unsubscribe { target }   native
 * out: hello { ops, mounted, state }                reply { requestId, ok, result|error }
 *      state { target, version, snapshot|patch }    event { target, name, data }
 *      error { message }                            (a frame that cannot be read at all)
 * ```
 *
 * Three things that used to be special are now the same thing as everything else:
 * the session list is the state of the `sessions` target, a session's view is the state
 * of `sessions.<id>`, and a plugin's panel is the state of whatever target it names —
 * `subscribe`, `state` frames and the diff below serve all of them. `queueRemove`'s
 * acknowledgement is a `reply`, not a message type.
 *
 * Type safety lives where the vocabulary lives: each registration declares a `schema`
 * and a `description`, `hello.ops` publishes them, and a client keeps its own types (or
 * generates them) against that. A client that calls something nobody registered gets
 * `reply { ok: false, error: "unknown op: sessions.promt" }` instead of a compile error —
 * the price of a server that knows no feature names, paid with a published contract.
 */
// ------------------------------------------------------------------- the client's side

/** One request. `requestId` is how the reply finds its way back; omitted means fire-and-forget. */
export interface CallFrame {
  op: "call";
  target: string;
  action: string;
  args?: unknown;
  requestId?: string;
}

/**
 * Subscribe to a target's state and events (idempotent).
 *
 * `filter` narrows the *events* a subscriber receives (a substring of the event name, so
 * `tool` catches the `tool:*` family); state is never filtered, because a panel that asked for
 * a target's state asked for the whole of it. Absent means everything.
 */
export interface SubscribeFrame {
  op: "subscribe";
  target: string;
  filter?: string;
}

export interface UnsubscribeFrame {
  op: "unsubscribe";
  target: string;
}

/**
 * The desktop shell closing the loop: a menu or tray item was clicked, or an update
 * changed state. The shell is a client like any other, so it has no separate channel —
 * it asks the pipe to fan one frame out.
 */
export type NativeFrame =
  | { op: "native"; kind: "menu" | "tray"; action: string; data?: unknown }
  | { op: "native"; kind: "update"; action: string; data?: unknown };

export type ClientFrame =
  | CallFrame
  | SubscribeFrame
  | UnsubscribeFrame
  | NativeFrame;

// ------------------------------------------------------------------- the server's side

/** What one registration publishes about itself. */
export interface OpDescriptor {
  /** `<target>.<action>`, the name a client calls. */
  name: string;
  target: string;
  action: string;
  description?: string | undefined;
  /** A JSON schema for `args`, when the owner declares one. */
  schema?: unknown;
}

/** One section of some target's state. */
export interface StateSnapshot {
  /** Every section, by name. Nothing here enumerates them. */
  sections: Record<string, unknown>;
  /** Per section: a cheap signature. Equal means that section did not change. */
  revisions: Record<string, string>;
}

/** The sections that changed, plus every revision the sender holds. */
export interface StatePatch {
  sections: Record<string, unknown>;
  revisions: Record<string, string>;
}

export interface HelloFrame<Mounted = unknown, Diagnostics = unknown> {
  type: "hello";
  /** Everything callable right now, with the contract each owner declared. */
  ops: OpDescriptor[];
  /** Every plugin the server has, with its front-end descriptor or the error that stopped it. */
  mounted: Mounted[];
  /** The state of every eager target: a client that just connected can draw immediately. */
  state: Record<string, StateSnapshot>;
  /** What the prompt layer last reported, when the server has one (a panel reads it). */
  diagnostics?: Diagnostics | undefined;
}

export interface ReplyFrame {
  type: "reply";
  requestId: string;
  ok: true;
  result?: unknown;
}

/** A failure the client translates: a stable code and the values its text needs. */
export interface ErrorProblem {
  code: string;
  params?: Record<string, string | number> | undefined;
}

export interface ReplyErrorFrame {
  type: "reply";
  requestId: string;
  ok: false;
  /** The server's own words; for a failure with a `problem`, a diagnostic for logs. */
  error: string;
  problem?: ErrorProblem | undefined;
}

/** A target's state, whole or as a delta. */
export interface StateFrame {
  type: "state";
  target: string;
  version: number;
  snapshot?: StateSnapshot;
  patch?: StatePatch;
}

/** Something happened on a target. Events are ephemeral: state is what a client keeps. */
export interface EventFrame {
  type: "event";
  target: string;
  name: string;
  data: unknown;
  /**
   * When it happened (epoch milliseconds), strictly increasing within a target, even across a
   * restart of the process. It is the event's identity: a client that is shown the replay ring
   * again (it re-subscribed) drops what is not later than the last event it already has.
   */
  at?: number;
}

/**
 * The event a target answers with when there is nothing behind its name: a subscription to a
 * target nobody registered (a task that was never made, a session that is gone), and a target
 * that was taken away while someone watched it. It carries no `at` and is not kept in the ring: it
 * is an answer to this subscriber, not something that happened. State for the target arriving
 * later (it was registered after all) supersedes it.
 */
export const TARGET_MISSING = "target:missing";

/** A frame the pipe could not read at all: no target, so nothing else can be said. */
export interface ErrorFrame {
  type: "error";
  message: string;
}

export type ServerFrame =
  | HelloFrame
  | ReplyFrame
  | ReplyErrorFrame
  | StateFrame
  | EventFrame
  | ErrorFrame;

/** The frame types this side of the pipe has. Pinned for the same reason as the op names. */
export const SERVER_FRAME_TYPES = [
  "error",
  "event",
  "hello",
  "reply",
  "state",
] as const;

// ------------------------------------------------------------------- the state diff

/**
 * What to send for a target's state, given the revisions a client already holds.
 *
 * `undefined` means nothing moved, so no frame is owed; `"full"` means the client holds
 * nothing (or asked again); otherwise a patch with only the sections whose revision
 * changed. **Absence in a patch means unchanged** — that is the whole rule, and it names
 * no field: the transcript appears exactly when the journal moves, and a plugin's panel
 * appears when its own revision moves.
 */
export function stateDiff(
  previous: Record<string, string> | undefined,
  snapshot: StateSnapshot,
): StatePatch | "full" | undefined {
  if (previous === undefined) return "full";
  const sections: Record<string, unknown> = {};
  let moved = false;
  for (const [name, revision] of Object.entries(snapshot.revisions)) {
    if (previous[name] === revision) continue;
    sections[name] = snapshot.sections[name];
    moved = true;
  }
  // A section that disappeared (a plugin unloaded) has no revision to compare: its
  // absence from the revisions is itself the change.
  for (const name of Object.keys(previous)) {
    if (name in snapshot.revisions) continue;
    delete sections[name];
    moved = true;
  }
  return moved ? { sections, revisions: snapshot.revisions } : undefined;
}

// ------------------------------------------------------------------- codec

export function encodeFrame(frame: ServerFrame): string {
  return JSON.stringify(frame);
}

export function decodeClientFrame(raw: string): ClientFrame {
  return JSON.parse(raw) as ClientFrame;
}
