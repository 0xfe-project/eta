/**
 * One assistant generation, with everything that can go wrong on the way
 * (REFACTOR.md §2.4 step 3).
 *
 * The loop above this function should read as "assemble the context, generate,
 * account for it". The three ways a generation goes sideways — a transport
 * failure worth retrying, a context overflow, and a stop that produced nothing
 * — are this function's business, and they are decided in one place:
 *
 *   overflow  → cut the history once (the caller's compaction service), retry
 *   transient → back off and retry, up to the policy's budget
 *   other     → return what came back; the caller decides what it means
 *
 * It is a function, not a service: it needs the caller's context assembly, its
 * stream observer, its abort signal, and its compaction service. Making it a
 * service would only mean passing all four back through a bus.
 */
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { isContextOverflow, isRecoverableLength, isRetryableAssistantError } from "@earendil-works/pi-ai";
import type { Emit } from "../types/events";
import type { ThinkingLevel } from "../types/messages";
import { consumeAssistantStream } from "./assistant";
import type { KernelModels } from "./providers";
import { type AgentRetryPolicy, normalizedRetryPolicy, retryDelayMs, retryNotBefore, waitUntil } from "./retry";

/** What the caller wants to hear about while a generation runs. */
export interface GenerationObserver {
	/** One stream frame: the message as it stands, plus the event that moved it. */
	update(message: AssistantMessage, event: AssistantMessageEvent): void;
}

export interface GenerateOptions {
	models: KernelModels;
	model: Model<Api>;
	streamOptions?: SimpleStreamOptions | undefined;
	thinkingLevel: ThinkingLevel;
	/** Aborts the stream and any backoff wait. */
	signal: AbortSignal;
	retryPolicy: AgentRetryPolicy;
	runId: string;
	/** The turn step the retry events name. */
	turnId: string;
	/** Assemble the request context. Called per attempt: a cut replaces it. */
	contextFor: () => Context;
	observer: GenerationObserver;
	emit: Emit;
	/** What the request asked the model to produce, for the length-stop signal. */
	intendedOutputLimit: number;
	/**
	 * Cut the history after an overflow. True means the context was replaced and
	 * the attempt is worth repeating; false means give up.
	 */
	recoverOverflow: () => Promise<boolean>;
}

/**
 * Generate one assistant message, retrying what is worth retrying.
 *
 * Always resolves with the message that settled the loop — including an errored
 * one, which the caller surfaces as the run's outcome. A failure that was
 * retried is never journaled by the caller: it is not history.
 */
export async function generateWithRetry(options: GenerateOptions): Promise<AssistantMessage> {
	const policy = normalizedRetryPolicy(options.retryPolicy);
	let attempt = 1;
	for (;;) {
		const context = options.contextFor();
		options.emit("prompt:assembled", {
			runId: options.runId,
			systemPromptChars: (context.systemPrompt ?? "").length,
			messages: context.messages.length,
			attempt,
		});

		const stream: AssistantMessageEventStream = options.models.streamSimple(options.model, context, {
			...options.streamOptions,
			signal: options.signal,
			// "off" is the kernel's spelling for "no reasoning field at all".
			...(options.thinkingLevel === "off" ? {} : { reasoning: options.thinkingLevel }),
		});
		const assistant = await consumeAssistantStream(stream, {
			start: () => {
				options.emit("message:start", { runId: options.runId, turnId: options.turnId });
			},
			update: (message, event) => {
				options.observer.update(message, event);
			},
			end: () => undefined,
		});

		if (assistant.stopReason !== "error" && assistant.stopReason !== "length") {
			if (attempt > 1) {
				options.emit("retry:end", { runId: options.runId, step: options.turnId, attempt, success: true });
			}
			return assistant;
		}

		// Context overflow: the same request cannot fit until the history shrinks,
		// so waiting would not help. The recovery is one-shot (the service owns
		// that budget) and a declined recovery ends the attempt.
		const overflow =
			isContextOverflow(assistant, options.model.contextWindow) ||
			isRecoverableLength(assistant, options.intendedOutputLimit);
		if (overflow) {
			if (await options.recoverOverflow()) continue;
			return assistant;
		}

		if (assistant.stopReason !== "error") return assistant;

		// A transport failure gets another attempt; a deterministic one (auth,
		// quota, a bad request) ends here rather than burning the budget.
		const retryable = isRetryableAssistantError(assistant);
		if (!retryable || attempt >= policy.maxAttempts) {
			if (attempt > 1) {
				options.emit("retry:end", {
					runId: options.runId,
					step: options.turnId,
					attempt,
					success: false,
					finalError: assistant.errorMessage ?? `Assistant request ended with ${assistant.stopReason}`,
				});
			}
			return assistant;
		}

		const notBefore = retryNotBefore(policy, attempt);
		options.emit("retry:scheduled", {
			runId: options.runId,
			step: options.turnId,
			attempt: attempt + 1,
			maxAttempts: policy.maxAttempts,
			delayMs: retryDelayMs(policy, attempt),
			notBefore,
			errorMessage: assistant.errorMessage ?? "Assistant request failed",
		});
		await waitUntil(notBefore, options.signal);
		attempt += 1;
		options.emit("retry:start", { runId: options.runId, step: options.turnId, attempt });
	}
}
