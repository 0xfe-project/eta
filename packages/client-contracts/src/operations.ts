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
}

/** The actions this target has. One list, so the wire and the plugin cannot disagree. */
export const PROVIDER_ACTIONS = [
  "save",
  "delete",
  "setDefault",
  "setNetwork",
  "reload",
  "refresh",
  "discover",
  "check",
  "logos",
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
  thinkingLevel: Session & { level: ThinkingLevel };
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
  kind?: import("./types").ProviderKind;
  baseUrl: string;
  /** Write-only; provider summaries expose hasApiKey instead. */
  apiKey?: string | null;
  headers?: import("./types").ProviderHeaders | null;
  models: import("./types").EtaModelConfig[];
}
export interface ProviderArgs {
  save: { revision: string; provider: ProviderInput };
  delete: { revision: string; id: string };
  setDefault: { revision: string; defaultModel?: string | null };
  setNetwork: { revision: string } & import("./types").NetworkConfig;
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
    kind: import("./types").ProviderKind;
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
