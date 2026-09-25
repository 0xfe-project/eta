/**
 * Scripted fake provider for tests. Implements the ProviderSeam by replaying
 * queued AssistantMessages and recording every call's (model, context, options).
 */
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ProviderSeam } from "../kernel/providers.ts";

export interface RecordedCall {
	model: Model<Api>;
	context: Context;
	options?: SimpleStreamOptions;
}

export function fakeProvider(script: AssistantMessage[]): ProviderSeam & { calls: RecordedCall[] } {
	const calls: RecordedCall[] = [];
	let i = 0;
	return {
		calls,
		async complete(model, context, options) {
			calls.push({ model, context, options });
			if (i >= script.length) {
				throw new Error("fakeProvider: script exhausted — the runner asked for more turns than scripted");
			}
			return script[i++];
		},
	};
}

export function assistantMessage(partial: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "fake",
		provider: "fake",
		model: "fake-model",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
		stopReason: "stop",
		timestamp: Date.now(),
		...partial,
	} as AssistantMessage;
}
