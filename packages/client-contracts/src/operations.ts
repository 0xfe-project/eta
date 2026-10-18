/** Bundled operation vocabulary. The generic wire package accepts arbitrary plugin actions. */

import type { CallFrame } from "@eta/client-wire-proto";
import type { JsonValue, Task, TaskStatus, ThinkingLevel } from "./data";
import type { SessionViewBtwThread } from "./types";

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
  "btwOpen",
  "btwAsk",
  "btwAnswer",
  "btwSave",
  "btwHandoff",
  "btwClear",
  "subagentStop",
  "history",
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
  "codexLogin",
  "codexAnswer",
  "codexStatus",
  "codexCancel",
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
type Thread = Session & { threadId: string };
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
  btwOpen: Session & { kind: SessionViewBtwThread["kind"] };
  btwAsk: Thread & { question: string };
  btwAnswer: Thread & { question: string; answer?: string };
  btwSave: Thread;
  btwHandoff: Thread;
  btwClear: Thread;
  subagentStop: Session & { id: string };
  history: Session & { beforeSeq?: number; limit?: number };
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
  refresh: { id: string };
  codexLogin: { method?: "browser" | "device_code" };
  codexAnswer: { id: string; promptId: string; value: string };
  codexStatus: { id: string };
  codexCancel: { id?: string };
}
export type ProviderCall = {
  [A in ProviderAction]: Omit<CallFrame, "target" | "action" | "args"> & {
    target: "providers";
    action: A;
    args: ProviderArgs[A];
  };
}[ProviderAction];
