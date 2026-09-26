/**
 * Kernel configuration — the vocabulary eta-agent splits between a durable
 * lane configuration (what the session is) and process-local settings (how
 * this process runs it). The kernel keeps both in one record: there is exactly
 * one lane, and the runner reads it live every turn.
 */
import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
import { type AgentRetryPolicy, DEFAULT_RETRY_POLICY } from "../kernel/retry.ts";
import type { ThinkingLevel } from "./messages.ts";

/** How an inbox drains at a run boundary. */
export type QueueMode = "all" | "one-at-a-time";

/** Whether a turn's tool calls run one after another or together. */
export type ToolExecution = "sequential" | "parallel";

/** Which model, thinking level, and tools the session is on. */
export interface ModelIdentity {
	provider: string;
	modelId: string;
}

export interface ModelConfig {
	model: ModelIdentity;
	thinkingLevel: ThinkingLevel;
	/** Names the session may call; the tool registry decides what exists. */
	activeToolNames: string[];
}

/**
 * Price model for deciding whether a cut earns its rewrite. Absent means
 * price-blind: compact on window pressure alone.
 */
export interface CompactionEconomics {
	/** What a cache write costs next to a cache read. 12.5 = 1.25x write against 0.1x read. */
	cacheWriteReadRatio: number;
	/** The first cut may act on a horizon this many times longer than the estimate. */
	firstCompactionRequestScale: number;
	/** Later cuts need this much margin over breakeven before they fire. */
	subsequentCompactionMargin: number;
}

export interface CompactionSettings {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
	economics?: CompactionEconomics;
}

export interface RuntimeConfig {
	compaction: CompactionSettings;
	retryPolicy: AgentRetryPolicy;
	steeringMode: QueueMode;
	followUpMode: QueueMode;
	toolExecution: ToolExecution;
	streamOptions?: SimpleStreamOptions;
}

export type KernelConfig = ModelConfig & RuntimeConfig;

export const DEFAULT_COMPACTION_ECONOMICS: CompactionEconomics = Object.freeze({
	cacheWriteReadRatio: 12.5,
	firstCompactionRequestScale: 2,
	subsequentCompactionMargin: 1.5,
});

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
};

export function defaultKernelConfig(overrides: Partial<KernelConfig> = {}): KernelConfig {
	return {
		model: { provider: "unknown", modelId: "unknown" },
		thinkingLevel: "off",
		activeToolNames: [],
		compaction: { ...DEFAULT_COMPACTION_SETTINGS },
		retryPolicy: { ...DEFAULT_RETRY_POLICY },
		steeringMode: "all",
		followUpMode: "all",
		toolExecution: "parallel",
		...overrides,
	};
}

/** Config properties that report a `state:config-update` when they change. */
export const CONFIG_PROPERTIES = [
	"model",
	"thinkingLevel",
	"activeToolNames",
	"compaction",
	"retryPolicy",
	"steeringMode",
	"followUpMode",
	"toolExecution",
	"streamOptions",
] as const satisfies readonly (keyof KernelConfig)[];

export type ConfigProperty = (typeof CONFIG_PROPERTIES)[number];
