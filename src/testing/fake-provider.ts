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
import type { KernelModels } from "../kernel/providers.ts";

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

/** The event sequence one settled message streams as. */
function eventsFor(message: AssistantMessage, chunkSize: number): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const partial: AssistantMessage = { ...message, stopReason: "pending" };
	stream.push({ type: "start", partial });

	message.content.forEach((part, contentIndex) => {
		if (part.type === "text") {
			stream.push({ type: "text_start", contentIndex, partial });
			for (const delta of chunk(part.text, chunkSize)) {
				stream.push({ type: "text_delta", contentIndex, delta, partial });
			}
			stream.push({ type: "text_end", contentIndex, content: part.text, partial });
			return;
		}
		if (part.type === "thinking") {
			stream.push({ type: "thinking_start", contentIndex, partial });
			for (const delta of chunk(part.thinking, chunkSize)) {
				stream.push({ type: "thinking_delta", contentIndex, delta, partial });
			}
			stream.push({ type: "thinking_end", contentIndex, content: part.thinking, partial });
			return;
		}
		if (part.type === "toolCall") {
			stream.push({ type: "toolcall_start", contentIndex, partial });
			for (const delta of chunk(JSON.stringify(part.arguments), chunkSize)) {
				stream.push({ type: "toolcall_delta", contentIndex, delta, partial });
			}
			stream.push({ type: "toolcall_end", contentIndex, toolCall: part, partial });
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
	const model = { provider: "fake", id: "fake-model", api: "openai-completions" } as unknown as Model<Api>;
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
