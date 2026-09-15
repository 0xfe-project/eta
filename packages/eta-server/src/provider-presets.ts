import type { ModelCapabilities } from "@eta/core/provider-config";

/**
 * DeepSeek's /models endpoint only publishes IDs and ownership. These fallbacks
 * are for the explicitly documented models, not every ID starting with deepseek.
 * API metadata, when present, takes precedence during discovery.
 *
 * Verified 2026-09-15:
 * https://api-docs.deepseek.com/quick_start/pricing/
 * https://api-docs.deepseek.com/guides/thinking_mode/
 * https://api-docs.deepseek.com/api/create-chat-completion/
 */
export function deepSeekCapabilities(id: string): ModelCapabilities | undefined {
	const flash = id === "deepseek-flash" || id === "deepseek-v4-flash" || id === "deepseek-v4-flash-vision-exp";
	if (!flash && id !== "deepseek-v4-pro") return undefined;
	return {
		name: flash ? (id === "deepseek-flash" ? "DeepSeek Flash" : id) : "DeepSeek V4 Pro",
		reasoning: true,
		thinkingMode: "both",
		reasoningEfforts: ["low", "high", "max"],
		providerDefaultEffort: "high",
		// Conservative 1M context budget. 128K is the documented default output
		// allowance for max effort, below the API's 393216-token maximum.
		contextWindow: 1_000_000,
		maxTokens: 131_072,
		input: flash ? ["text", "image"] : ["text"],
	};
}
