import type { Authorizer, Effect } from "./realm";

/**
 * The seam between the runtime and whatever is hosting it.
 *
 * Nothing below is implemented here. esm-mode owns the realm, the module graph,
 * the effect ledger and `env.js`; everything that needs a session, a model, a
 * human or a platform service is a slot the host fills. The test for whether
 * this file is right is whether eta can be wired up without esm-mode learning
 * what a turn or a conversation is.
 */

export interface Frame {
  /** This frame's id. Stable for the duration of one run. */
  id: string;
  /** The frame that asked for this one, or `null` at the top. */
  parent: string | null;
  /** Monotonic per parent; orders siblings. */
  seq: number;
}

export interface MessageView {
  role: string;
  text: string;
}

export interface BudgetView {
  /** Total the turn may spend, in tokens. */
  limit: number;
  spent: number;
}

/** What a script sees as `ctx`. A function, not a value, where it would be big. */
export interface CtxView {
  frame: Frame;
  /** The last `count` messages. A method because materialising the transcript is wasteful. */
  messages: (count?: number) => Promise<MessageView[]>;
  budget: BudgetView;
}

export interface EmitSink {
  text: (text: string) => void;
  progress: (text: string) => void;
  image: (input: { mime: string; base64: string; alt?: string }) => void;
}

export interface EditRequest {
  path: string;
  find: string;
  replace: string;
}

export interface EditResult {
  ok: boolean;
  diff?: string;
  reason?: string;
}

export interface ToolsSink {
  /** Exact-match replacement. `fs.writeFile` overwrites; this refuses an ambiguous match. */
  edit: (request: EditRequest) => Promise<EditResult>;
  ask: (question: string) => Promise<string>;
}

export interface MemorySink {
  append: (text: string) => Promise<void>;
  read: (query: string) => Promise<string>;
}

/**
 * A platform call.
 *
 * `kind` is what the ledger does with it: `det` is a deterministic local call,
 * `opaque` is a service whose behaviour we cannot inspect, `cost` is a paid
 * call that also draws down `ctx.budget`.
 */
export interface PlatformCall {
  (input: unknown): Promise<unknown>;
  kind?: "det" | "opaque" | "cost";
}

export interface SpawnRequest {
  prompt: string;
  model?: string;
}

export interface SpawnResult {
  text: string;
  effects: Effect[];
}

export interface AskRequest {
  prompt: string;
  model?: string;
  /**
   * Parent call stack: what was calling eta.ask.
   * Carried forward in recursion.
   */
  parentStack?: string[];
}

export interface AskResult {
  /** Model's reply (with call stack prepended). */
  text: string;
  /** All effects produced in this turn. */
  effects: Effect[];
  /** Structured call stack. */
  stack: string[];
  /** Whether the turn completed successfully or was cancelled. */
  status: "completed" | "cancelled";
  /** Warning for deep recursion (≥10 layers). */
  warning?: string;
}

/**
 * The whole host surface.
 *
 * Every function here is optional: a realm with no hooks still evaluates
 * modules, it just has nothing to talk to. That is deliberate — the runtime
 * should be testable without a session, and a host should be able to start by
 * filling in only the slots it has.
 */
export interface Hooks {
  /** `console` from inside the realm. Debug output, not `emit`. */
  onConsole?: (level: string, line: string) => void;
  /** Called as each effect completes, so a host can stream rather than wait. */
  onEffect?: (effect: Effect) => void;
  /**
   * Asked before a binding reaches the host. Absent means everything runs, so
   * a host that has not written a policy yet is not silently gated.
   */
  authorize?: Authorizer;

  ctx?: () => CtxView;
  emit?: Partial<EmitSink>;
  tools?: Partial<ToolsSink>;
  memory?: MemorySink;
  platform?: Record<string, PlatformCall>;
  /** A real sub-turn. Recursion, budget and cycles are the host's to enforce. */
  spawn?: (request: SpawnRequest) => Promise<SpawnResult>;
  /** Call the current agent with a new turn. Supports recursion and sees full history. */
  ask?: (request: AskRequest) => Promise<AskResult>;
}
