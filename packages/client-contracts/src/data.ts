/** Serialized message and session data; additions are versioned here, not inherited from runtime classes. */
export interface TextContent {
  type: "text";
  text: string;
  textSignature?: string;
}
export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
  /** When true, the thinking content was redacted by safety filters. The opaque
   *  encrypted payload is stored in `thinkingSignature` so it can be passed back
   *  to the API for multi-turn continuity. */
  redacted?: boolean;
}
export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}
export interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, JsonValue>;
  thoughtSignature?: string;
  /** OpenAI Responses namespace for calls to dynamically loaded or namespaced tools. */
  namespace?: string;
}
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Subset of `cacheWrite` written with 1h retention. Only Anthropic reports this split. */
  cacheWrite1h?: number;
  /**
   * Reasoning/thinking tokens, when the provider reports them. This is a subset of
   * `output`: `output` already includes these tokens. Set to a number (possibly 0) by
   * providers that expose a reasoning breakdown; left undefined by providers that don't.
   */
  reasoning?: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}
export type StopReason =
  | "pending"
  | "stop"
  | "length"
  | "toolUse"
  | "error"
  | "aborted"
  | "deferred";
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | {
      [key: string]: JsonValue;
    };
export interface DeferredHandle {
  provider: string;
  modelId: string;
  api: string;
  /** Provider token, such as a response id or batch id plus row id. */
  id: string;
  expiresAt?: number;
  pollAfterMs?: number;
  /** Provider conversion data required to reconstruct the final assistant message. */
  data?: JsonValue;
}
export interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;
}
export interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  api: string;
  provider: string;
  model: string;
  responseModel?: string;
  responseId?: string;
  /** Exact provider-native effort level used for this response. Absent for legacy or unmanaged responses. */
  providerThinkingLevel?: string;
  diagnostics?: AssistantMessageDiagnostic[];
  usage: Usage;
  stopReason: StopReason;
  deferred?: DeferredHandle;
  errorMessage?: string;
  rawStopReason?: string;
  /**
   * Provider indication of whether the model explicitly ended its turn.
   * Preserved for debugging and does not currently affect agent control flow.
   */
  endTurn?: boolean;
  timestamp: number;
}
export interface ToolResultMessage<TDetails extends JsonValue = JsonValue> {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: TDetails;
  /** Usage from the tool execution itself, if available. Not part of main LLM context accounting. */
  usage?: Usage;
  /**
   * Names from `Context.tools` that became available after this result.
   * Providers with native deferred tool loading use this as the load point;
   * other providers ignore it and use `Context.tools` normally.
   */
  addedToolNames?: string[];
  isError: boolean;
  timestamp: number;
}
export type Message = UserMessage | AssistantMessage | ToolResultMessage;

/** Model thinking-level knob, mirrored from the fork. */
export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

/** A compaction summary standing in for the history it replaced. */
export interface CompactionSummaryMessage {
  role: "compactionSummary";
  summary: string;
  tokensBefore: number;
  timestamp: number;
}

/** A branch summary standing in for the branch it replaced. */
export interface BranchSummaryMessage {
  role: "branchSummary";
  summary: string;
  fromId: string | null;
  timestamp: number;
}

/** Extensible interface for custom app messages (declaration merging). */
export interface CustomAgentMessages {
  compactionSummary: CompactionSummaryMessage;
  branchSummary: BranchSummaryMessage;
}

/** Union of LLM messages + custom messages. */
export type AgentMessage =
  | Message
  | CustomAgentMessages[keyof CustomAgentMessages];

/** Task vocabulary: four states plus dependency edges. */
export type TaskStatus = "pending" | "in_progress" | "completed" | "cancelled";

/** One planned step in the agent's task list. */
export interface Task {
  id: string;
  content: string;
  status: TaskStatus;
  priority?: "high" | "medium" | "low";
}

/** Task with dependency edges; persisted whole under the session tasks value. */
export interface StoredTask extends Task {
  /** Ids this task waits on; reverse edges are computed, not duplicated. */
  dependsOn?: string[];
  /** Ids waiting on this task. */
  blocks?: string[];
}

export interface GoalState {
  objective: string;
  status: "active" | "paused" | "achieved";
  roundCount: number;
  idleWithoutTools: number;
  blockedReason?: "question-pending";
}
export interface AskPayload {
  questionId: string;
  question: string;
  options?: string[];
  multi?: boolean;
}

export interface AssistantMessageDiagnostic {
  type: string;
  timestamp: number;
  error?: {
    name?: string;
    message: string;
    stack?: string;
    code?: string | number;
  };
  details?: Record<string, JsonValue>;
}
