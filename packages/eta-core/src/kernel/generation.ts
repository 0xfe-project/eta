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
import type { Emit } from "../types/events";
import type { AgentMessage, ThinkingLevel } from "../types/messages";
import type { RunFailure } from "./failure";
import type { KernelModels } from "./providers";
import type { AgentRetryPolicy } from "./retry";
import {
  isContextOverflow,
  isRecoverableLength,
} from "@earendil-works/pi-ai";
import {
  AssistantStreamError,
  consumeInterruptibleStream,
  STOP_STREAM,
} from "./assistant";
import { classifyFailure, describeFailure } from "./failure";
import {
  normalizedRetryPolicy,
  retryDelayMs,
  retryNotBefore,
  waitUntil,
} from "./retry";

/**
 * A request to stop the generation in flight, throw its partial output away,
 * add messages to the transcript, and generate again.
 *
 * It is the one thing a stream observer can answer a frame with. The discarded
 * partial never reaches the transcript or the journal; the injected messages do
 * (they are what the model reads on the next attempt), so the history says why
 * the attempt that follows is different.
 */
export interface GenerationInterrupt {
  /** Why the generation was stopped; recorded with the interruption. */
  reason: string;
  /** Who asked (a rule id, a plugin name); recorded with the interruption. */
  source?: string;
  /** Messages the transcript gains before the next attempt. */
  inject?: readonly AgentMessage[];
}

/** How many times one turn's generation may be interrupted before frames are no longer asked. */
export const DEFAULT_MAX_INTERRUPTS = 8;

/** What the caller wants to hear about while a generation runs. */
export interface GenerationObserver {
  /**
   * One stream frame: the message as it stands, plus the event that moved it.
   * Answering with an interrupt stops the generation; the frame is the last one
   * of that attempt.
   */
  update: (
    message: AssistantMessage,
    event: AssistantMessageEvent,
  ) =>
    | GenerationInterrupt
    | undefined
    | void
    | Promise<GenerationInterrupt | undefined | void>;
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
  /**
   * An observer interrupt took effect: the attempt was stopped and `partial` is
   * what it had produced. Called before the next attempt assembles its context,
   * so whatever it adds to the transcript is part of that request.
   */
  onInterrupt?: (
    interrupt: GenerationInterrupt,
    partial: AssistantMessage,
    count: number,
  ) => void;
  /** Interrupts honoured per call; later ones are ignored. Default `DEFAULT_MAX_INTERRUPTS`. */
  maxInterrupts?: number;
  /**
   * Make the transcript a request the provider will accept, and say whether it
   * changed anything. Wired by the owner of the transcript: an orphaned tool
   * result or a tool call with no answer is refused with a 400, so the retry
   * after a refused request is worth making only if this repaired something.
   *
   * Called at most once per generation: a repair that changed nothing, retried,
   * is the same refused request again, and burning attempts on it is burning
   * money.
   */
  repairTranscript?: (() => Promise<boolean>) | undefined;
  /**
   * The failure the loop settled on, when it settled on one. The caller needs it
   * to say what happened: the message's own `errorMessage` is the provider's
   * raw text, and this is that text turned into a fact.
   */
  onFailure?: ((failure: RunFailure) => void) | undefined;
}

/**
 * Generate one assistant message, retrying what is worth retrying.
 *
 * Always resolves with the message that settled the loop — including an errored
 * one, which the caller surfaces as the run's outcome. A failure that was
 * retried is never journaled by the caller: it is not history.
 */
export async function generateWithRetry(
  options: GenerateOptions,
): Promise<AssistantMessage> {
  const policy = normalizedRetryPolicy(options.retryPolicy);
  let attempt = 1;
  let interrupts = 0;
  /** Whether the transcript has already been repaired for this generation. */
  let repaired = false;
  const maxInterrupts = options.maxInterrupts ?? DEFAULT_MAX_INTERRUPTS;
  for (;;) {
    const context = options.contextFor();
    // This attempt's own stop: an interrupt aborts the request behind the
    // stream without touching the run's signal.
    const attemptStop = new AbortController();
    const attemptSignal = AbortSignal.any([options.signal, attemptStop.signal]);
    options.emit("prompt:assembled", {
      runId: options.runId,
      systemPromptChars: (context.systemPrompt ?? "").length,
      messages: context.messages.length,
      attempt,
    });

    const stream: AssistantMessageEventStream = options.models.streamSimple(
      options.model,
      context,
      {
        ...options.streamOptions,
        signal: attemptSignal,
        // "off" is the kernel's spelling for "no reasoning field at all".
        ...(options.thinkingLevel === "off"
          ? {}
          : { reasoning: options.thinkingLevel }),
      },
    );
    let interrupt = undefined as GenerationInterrupt | undefined;
    let partial = undefined as AssistantMessage | undefined;
    // A request the provider refused before the stream opened still has a
    // message: the `error` event carries it. Reading it is what turns "error
    // before start" into "HTTP 400, and here is what the provider said".
    let assistant = undefined as AssistantMessage | undefined;
    try {
      assistant = await consumeInterruptibleStream(stream, {
        start: () => {
          options.emit("message:start", {
            runId: options.runId,
            turnId: options.turnId,
          });
        },
        update: async (message, event) => {
          partial = message;
          const verdict = await options.observer.update(message, event);
          if (verdict === undefined || interrupts >= maxInterrupts) return;
          interrupt = verdict;
          attemptStop.abort();
          return STOP_STREAM;
        },
        end: () => undefined,
      });
    } catch (caught) {
      if (!(caught instanceof AssistantStreamError)) throw caught;
      assistant = caught.assistant;
    }

    if (assistant === undefined && interrupt !== undefined && partial) {
      // The attempt is over and nothing it produced is history. The interrupt
      // is told first, so what it injects is in the next request's context.
      interrupts += 1;
      options.onInterrupt?.(interrupt, partial, interrupts);
      continue;
    }
    if (assistant === undefined)
      throw new Error("Assistant stream stopped without an interrupt");

    if (assistant.stopReason !== "error" && assistant.stopReason !== "length") {
      if (attempt > 1) {
        options.emit("retry:end", {
          runId: options.runId,
          step: options.turnId,
          attempt,
          success: true,
        });
      }
      return assistant;
    }

    // One classification for every kind of failure, so the decision to retry and
    // the facts the caller shows come from the same reading of the same message.
    const failure = classifyFailure(assistant, {
      provider: options.model.provider,
      modelId: options.model.id,
      attempt,
    });
    const settle = (): AssistantMessage => {
      if (attempt > 1) {
        options.emit("retry:end", {
          runId: options.runId,
          step: options.turnId,
          attempt,
          success: false,
          finalError: assistant.errorMessage ?? describeFailure(failure),
        });
      }
      options.onFailure?.(failure);
      return assistant;
    };

    // Context overflow: the same request cannot fit until the history shrinks,
    // so waiting would not help. The recovery is one-shot (the service owns
    // that budget) and a declined recovery ends the attempt.
    const overflow =
      isContextOverflow(assistant, options.model.contextWindow) ||
      isRecoverableLength(assistant, options.intendedOutputLimit) ||
      failure.code === "context_overflow";
    if (overflow) {
      if (await options.recoverOverflow()) continue;
      return settle();
    }

    if (assistant.stopReason !== "error") return assistant;

    // A refused request shape is repaired, not waited out: the transcript is
    // made valid, and if that changed anything the same request is worth one
    // more try. A repair that changed nothing ends here — retrying it would be
    // the same 400 until the budget ran out.
    if (failure.code === "invalid_request" && !repaired) {
      repaired = true;
      const changed = (await options.repairTranscript?.()) === true;
      if (changed && attempt < policy.maxAttempts) {
        attempt += 1;
        options.emit("retry:scheduled", {
          runId: options.runId,
          step: options.turnId,
          attempt,
          maxAttempts: policy.maxAttempts,
          delayMs: 0,
          notBefore: Date.now(),
          errorMessage: assistant.errorMessage ?? describeFailure(failure),
          reason: "repair",
        });
        options.emit("retry:start", {
          runId: options.runId,
          step: options.turnId,
          attempt,
        });
        continue;
      }
      return settle();
    }

    // A transport failure gets another attempt; a deterministic one (auth,
    // quota, a missing model) ends here rather than burning the budget.
    if (!failure.retryable || attempt >= policy.maxAttempts) return settle();

    const notBefore = retryNotBefore(policy, attempt);
    options.emit("retry:scheduled", {
      runId: options.runId,
      step: options.turnId,
      attempt: attempt + 1,
      maxAttempts: policy.maxAttempts,
      delayMs: retryDelayMs(policy, attempt),
      notBefore,
      errorMessage: assistant.errorMessage ?? describeFailure(failure),
      reason: "transient",
    });
    await waitUntil(notBefore, options.signal);
    attempt += 1;
    options.emit("retry:start", {
      runId: options.runId,
      step: options.turnId,
      attempt,
    });
  }
}
