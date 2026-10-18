/**
 * Scripted model layer for tests.
 *
 * Wraps a list of settled assistant messages into a real pi-ai event stream —
 * `AssistantMessageEventStream` is pi-ai's own class, so what the runner
 * consumes in tests is the shape it consumes in production. The event
 * sequence is derived from the message: text and thinking parts stream as
 * deltas, tool calls stream as JSON fragments, then `done` carries the settled
 * message. `chunkSize` controls how finely deltas are cut.
 */
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { KernelModels } from "../kernel/providers";

export interface RecordedCall {
	model: Model<Api>;
	context: Context;
	options: SimpleStreamOptions | undefined;
}

export interface FakeModelsOptions {
	/** Characters per streamed delta. Default: the whole part in one frame. */
	chunkSize?: number;
}

export type FakeModels = KernelModels & { calls: RecordedCall[] };

/** A settled assistant message with the required fields filled in. */
export function assistantMessage(partial: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "fake",
		model: "fake-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
		...partial,
	};
}

function chunk(text: string, size: number): string[] {
	if (size <= 0 || text.length <= size) return [text];
	const parts: string[] = [];
	for (let index = 0; index < text.length; index += size) parts.push(text.slice(index, index + size));
	return parts;
}

/** Tokens a provider would estimate for text it has not been billed for yet. */
function estimateStreamedTokens(chars: number): number {
	return Math.ceil(chars / 4);
}

/** The event sequence one settled message streams as. */
function eventsFor(message: AssistantMessage, chunkSize: number): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	// Like a real provider: the partial's usage grows as tokens stream, and the
	// settled message replaces it with the count the provider actually charged.
	let streamedChars = 0;
	const partial: AssistantMessage = { ...message, stopReason: "pending" };
	const withEstimate = (): AssistantMessage => ({
		...partial,
		usage: { ...partial.usage, output: estimateStreamedTokens(streamedChars) },
	});
	stream.push({ type: "start", partial: withEstimate() });

	message.content.forEach((part, contentIndex) => {
		if (part.type === "text") {
			stream.push({ type: "text_start", contentIndex, partial: withEstimate() });
			for (const delta of chunk(part.text, chunkSize)) {
				streamedChars += delta.length;
				stream.push({ type: "text_delta", contentIndex, delta, partial: withEstimate() });
			}
			stream.push({ type: "text_end", contentIndex, content: part.text, partial: withEstimate() });
			return;
		}
		if (part.type === "thinking") {
			stream.push({ type: "thinking_start", contentIndex, partial: withEstimate() });
			for (const delta of chunk(part.thinking, chunkSize)) {
				streamedChars += delta.length;
				stream.push({ type: "thinking_delta", contentIndex, delta, partial: withEstimate() });
			}
			stream.push({ type: "thinking_end", contentIndex, content: part.thinking, partial: withEstimate() });
			return;
		}
		if (part.type === "toolCall") {
			stream.push({ type: "toolcall_start", contentIndex, partial: withEstimate() });
			for (const delta of chunk(JSON.stringify(part.arguments), chunkSize)) {
				streamedChars += delta.length;
				stream.push({ type: "toolcall_delta", contentIndex, delta, partial: withEstimate() });
			}
			stream.push({ type: "toolcall_end", contentIndex, toolCall: part, partial: withEstimate() });
		}
	});

	const reason = message.stopReason === "pending" ? "stop" : message.stopReason;
	if (reason === "aborted" || reason === "error") {
		stream.push({ type: "error", reason, error: message });
		stream.end(message);
		return stream;
	}
	stream.push({ type: "done", reason, message });
	stream.end(message);
	return stream;
}

/**
 * A model layer that answers from `script`, one message per request. Ask for
 * more than the script holds and it throws: a test that overruns its script is
 * a test with a wrong expectation, and silently repeating the last answer
 * would hide that.
 */
export function fakeModels(script: AssistantMessage[], options: FakeModelsOptions = {}): FakeModels {
	const calls: RecordedCall[] = [];
	let index = 0;
	const chunkSize = options.chunkSize ?? Number.MAX_SAFE_INTEGER;
	const next = (call: RecordedCall): AssistantMessage => {
		calls.push(call);
		const message = script[index];
		index += 1;
		if (message === undefined) {
			throw new Error("fakeModels: script exhausted — the runner asked for more turns than scripted");
		}
		return message;
	};
	// A fake that reasons: the battery under test (compaction, thinking levels, effort) should
	// exercise the capable path, and a test that wants a model which cannot think says so.
	const model = {
		provider: "fake",
		id: "fake-model",
		api: "openai-completions",
		reasoning: true,
	} as unknown as Model<Api>;
	return {
		calls,
		getModel: () => model,
		streamSimple: (_model, context, streamOptions) => {
			const message = next({ model: _model, context, options: streamOptions });
			return eventsFor(message, chunkSize);
		},
		completeSimple: async (_model, context, streamOptions) =>
			next({ model: _model, context, options: streamOptions }),
	};
}
