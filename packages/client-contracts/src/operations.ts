/** Bundled operation vocabulary. The generic wire package accepts arbitrary plugin actions. */

import type { CallFrame } from "@eta/client-wire-proto";
import type { JsonValue, Task, TaskStatus, ThinkingLevel } from "./data";

/** The actions this target has. One list, so the wire and the plugin cannot disagree. */
export const SESSION_ACTIONS = [
  "create",
  "delete",
  "focus",
  "resync",
  "prompt",
  "abort",
  "rename",
  "pin",
  "archive",
  "fork",
  "compact",
  "history",
  "image",
  "search",
  "goal",
  "taskCreate",
  "taskUpdate",
  "taskSet",
  "taskRemove",
  "stateDelete",
  "answer",
  "askAbort",
  "modelSet",
  "thinkingLevel",
  "queueRemove",
] as const;
export type SessionAction = (typeof SESSION_ACTIONS)[number];

export interface PromptImage {
  mime: string;
  dataBase64: string;
}

export interface PromptInput {
  text: string;
  mode?: "queue" | "steer" | undefined;
  images?: PromptImage[] | undefined;
  /**
   * Take the words only into a run in flight: on a session with no run the call fails and nothing
   * is queued. Without it a steer into an idle session starts a run with the words. The session's
   * own machine answers this, so a caller elsewhere (the primary, for a daemon's session) does not
   * race the end of the turn with a check of its own.
   */
  ifRunning?: boolean | undefined;
}

/** The actions this target has. One list, so the wire and the plugin cannot disagree. */
export const PROVIDER_ACTIONS = [
  "save",
  "delete",
  "setNetwork",
  "setPrivateNetwork",
  "reload",
  "refresh",
  "discover",
  "check",
  "logos",
  "readBalance",
] as const;

export interface CreateSessionInput {
  cwd?: string;
  title?: string;
  persona?: string;
  model?: string;
}
export interface ForkSessionInput {
  entryId?: string;
  position?: "at" | "before";
  title?: string;
}

interface Session {
  session: string;
}
/**
 * What became of a `/compact` on a session an external runtime answers in. Only `completed` means
 * the context shrank: `unconfirmed` is a wait that ended without the runtime's word, and it may
 * still be working.
 */
export interface RuntimeCompaction {
  /** The runtime, as the user knows it. */
  runtime: string;
  outcome:
    | "completed"
    | "empty"
    | "busy"
    | "unsupported"
    | "aborted"
    | "failed"
    | "unconfirmed";
  /** The runtime's own words, for `failed` and `unconfirmed`. */
  reason?: string;
}

/** The answer to `sessions.compact`; `runtime` is there on a session an external runtime answers in. */
export interface CompactResult {
  session: string;
  compacted: boolean;
  runtime?: RuntimeCompaction;
}

/** Valid requests from a client. The server still validates untrusted JSON at runtime. */
export interface SessionArgs {
  create: CreateSessionInput;
  delete: Session;
  focus: Session;
  resync: Session;
  prompt: Session & PromptInput;
  abort: Session;
  rename: Session & { title?: string };
  pin: Session & { pinned: boolean };
  archive: Session & { archived: boolean };
  fork: Session & ForkSessionInput;
  compact: Session & { instructions?: string };
  history: Session & { beforeSeq?: number; limit?: number };
  /**
   * One picture a view left out (`ImageContent.bytes` set, `data` empty): the image part at
   * `index` in the `content` of the message entry `entryId`. Answers `SessionImage`.
   */
  image: Session & { entryId: string; index: number };
  search: { query: string };
  goal: Session & {
    action: "set" | "pause" | "resume" | "clear";
    objective?: string;
  };
  taskCreate: Session & { content: string; priority?: Task["priority"] };
  taskUpdate: Session & {
    id: string;
    content?: string;
    status?: TaskStatus;
    deps?: string[];
    priority?: Task["priority"];
  };
  taskSet: Session & { id: string; status: TaskStatus };
  taskRemove: Session & { id: string };
  stateDelete: Session & { key: string };
  answer: Session & { questionId: string; response?: JsonValue };
  askAbort: Session & { questionId: string };
  modelSet: Session & { model: string };
  /**
   * `null` follows the model's default. `fallback` keeps a level the model does not take as the
   * session's ask and runs on the model's default instead of refusing it (an agent's level).
   */
  thinkingLevel: Session & { level: ThinkingLevel | null; fallback?: boolean };
  /**
   * Take one queued input back out of the lane. The answer says whether it was still there: a run
   * drains the queue at tool boundaries, so "the chip is gone" proves nothing and the caller has to
   * be told. Removed: false means a run took it first and the message is already on its way.
   */
  queueRemove: Session & { entryId: string };
}

/** A discriminated call union, assignable to the vocabulary-free CallFrame. */
export type SessionCall = {
  [A in SessionAction]: Omit<CallFrame, "target" | "action" | "args"> & {
    target: "sessions";
    action: A;
    args: SessionArgs[A];
  };
}[SessionAction];

export type ProviderAction = (typeof PROVIDER_ACTIONS)[number];
export interface ProviderInput {
  id: string;
  name?: string;
  kind?: import("./providers").ProviderKind;
  baseUrl: string;
  /** Write-only; provider summaries expose hasApiKey instead. */
  apiKey?: string | null;
  headers?: import("./types").ProviderHeaders | null;
  models: import("./types").EtaModelConfig[];
}
export interface BalanceLine {
  currency: "CNY" | "USD";
  available: string;
}

export interface MonthlyUsage {
  usedPercent: number;
  resetsAt?: string;
}

export type SourceSummary =
  | {
      source: "provider";
      id: string;
      balanceRevision: string;
      value: { balance: { lines: BalanceLine[] } } | null;
    }
  | {
      source: "account";
      id: string;
      quotaRevision: string | null;
      value: { monthly: MonthlyUsage } | null;
    };

export interface SourceSummaries {
  items: SourceSummary[];
}

export interface SourceQuota extends MonthlyUsage {
  period: "weekly" | "monthly";
}

export type SourceSummaryUpdate =
  | Extract<SourceSummary, { source: "provider" }>
  | (Omit<Extract<SourceSummary, { source: "account" }>, "value"> & {
      value: { quota: SourceQuota } | null;
    });

export interface SourceSummariesVisit {
  visitId: string;
}

export type SourceSummaryEvent = SourceSummariesVisit & SourceSummaryUpdate;

export interface ProviderBalance {
  state:
    | "available"
    | "query"
    | "missing_key"
    | "invalid_key"
    | "forbidden"
    | "timeout"
    | "rate_limited"
    | "unavailable"
    | "unsupported"
    | "spend_only";
  lines?: BalanceLine[];
  observedAt?: string;
  partial?: boolean;
  failedCurrencies?: BalanceLine["currency"][];
  retryAt?: string;
}

export interface ProviderArgs {
  readBalance: { id: string; refresh?: boolean };
  save: { revision: string; provider: ProviderInput };
  delete: { revision: string; id: string };
  setNetwork: { revision: string } & import("./types").NetworkConfig;
  /**
   * Replace the private-network list and switch. A new entry that is not valid refuses the whole
   * save (`invalid_private_network: <reason> <entry>`); one already in the file is kept as it is.
   */
  setPrivateNetwork: { revision: string; allow: string[]; loopback: boolean };
  reload: Record<string, never>;
  /**
   * List the models a saved provider serves now, with models.dev's facts where its endpoint is an
   * official one. The facts of configured models are brought up to date; nothing is added.
   */
  refresh: { id: string };
  /** Check saved providers (one, or all when `id` is absent): their model list is the probe. */
  check: { id?: string };
  /** The models.dev logo of each source asked about, by the key the caller gave it. */
  logos: { sources: ProviderLogoRequest[] };
  /**
   * Preview unsaved connection values: the model list, with models.dev's facts where the endpoint
   * is an official one. Never writes configuration.
   */
  discover: {
    id?: string;
    revision?: string;
    kind: import("./providers").ProviderKind;
    baseUrl: string;
    apiKey?: string | null;
    headers?: import("./types").ProviderHeaders | null;
  };
}
/** What `providers.discover` answers: the models to offer, and the ones listed but not usable. */
export interface ProviderDiscoverResult {
  models: import("./types").EtaModelConfig[];
  unsupported?: import("./types").UnsupportedModel[];
}
/**
 * What `providers.refresh` answers: every model the provider lists now (configured or not), the
 * ones listed but not usable, and the configured ids its catalog stopped listing (models.dev only).
 */
export interface ProviderRefreshResult extends ProviderDiscoverResult {
  revision: string;
  delisted?: string[];
}
/**
 * One source whose logo is wanted: a models.dev provider id when the caller knows it (a gateway
 * connector), else the base URL, which is matched against the `api` of each models.dev entry.
 */
export interface ProviderLogoRequest {
  key: string;
  id?: string;
  baseUrl?: string;
}
/** What `providers.logos` answers: the SVG of every source that has one, by its key. */
export interface ProviderLogosResult {
  logos: Record<string, string>;
}
/** What `providers.check` answers: the check of every provider it looked at, by id. */
export interface ProviderCheckResult {
  checks: Record<string, import("./types").ProviderCheck>;
}
export type ProviderCall = {
  [A in ProviderAction]: Omit<CallFrame, "target" | "action" | "args"> & {
    target: "providers";
    action: A;
    args: ProviderArgs[A];
  };
}[ProviderAction];
