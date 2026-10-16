/**
 * A model layer whose request says nothing until the run is aborted.
 *
 * Stopping a reply cannot be tested with a model that answers at once: there would be no run left
 * to stop. This one behaves the way a real provider does when its read is cancelled by the signal
 * the kernel passes down — it ends with a plain `Error("aborted")`, which the kernel reads as
 * "stopped because it was asked to" rather than as a fault. The same shape is used one level down
 * in `packages/eta-core/test/cancellation.test.ts`.
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { KernelModels } from "@eta/core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { fakeModels } from "@eta/core/testing";

export interface HangingModels {
  models: KernelModels;
  /** Resolves once the first request has actually reached the provider. */
  requested: Promise<void>;
  /** Every signal the provider was handed, newest last. */
  signals: (AbortSignal | undefined)[];
}

/** A stream that yields nothing until `signal` fires, then throws. */
function waitingStream(signal: AbortSignal | undefined): unknown {
  const fired = new Promise<void>((resolve) => {
    if (signal?.aborted === true) resolve();
    else signal?.addEventListener("abort", () => resolve(), { once: true });
  });
  return {
    // pi-ai's stream is consumed with `for await` and then asked for its result; both have to
    // wait for the abort, or the run would end on its own and there would be nothing to stop.
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        await fired;
        throw new Error("aborted");
      },
    }),
    result: async () => {
      await fired;
      throw new Error("aborted");
    },
  };
}

/**
 * A model layer whose first request starts streaming and then breaks.
 *
 * Not the same thing as a provider that refuses before there is a stream at all: this one is
 * already in flight when it throws, which is what a dropped connection looks like. The usage
 * recorder sits between the kernel and the provider, so this is also the case where that proxy has
 * to hand a failure on rather than let the stream end.
 */
export function breakingModels(message: string): {
  models: KernelModels;
  requested: Promise<void>;
} {
  const scripted = fakeModels([]);
  let resolveRequested!: () => void;
  const requested = new Promise<void>((resolve) => {
    resolveRequested = resolve;
  });
  let first = true;
  return {
    requested,
    models: {
      getModel: (provider, id) => scripted.getModel(provider, id),
      streamSimple: (model, context, options) => {
        resolveRequested();
        if (!first) return scripted.streamSimple(model, context, options);
        first = false;
        return {
          [Symbol.asyncIterator]: () => ({
            next: async () => {
              // The stream is live, and then it breaks.
              throw new Error(message);
            },
          }),
          result: async () => {
            throw new Error(message);
          },
        } as never;
      },
      completeSimple: async (model, context, options) =>
        scripted.completeSimple(model, context, options),
    },
  };
}

export function hangingModels(_unused?: AssistantMessage): HangingModels {
  const scripted = fakeModels([]);
  const signals: (AbortSignal | undefined)[] = [];
  let resolveRequested!: () => void;
  const requested = new Promise<void>((resolve) => {
    resolveRequested = resolve;
  });
  let first = true;
  const models: KernelModels = {
    getModel: (provider, id) => scripted.getModel(provider, id),
    streamSimple: (_model, _context, options) => {
      signals.push(options?.signal);
      resolveRequested();
      if (!first) return scripted.streamSimple(_model, _context, options);
      first = false;
      return waitingStream(options?.signal) as never;
    },
    completeSimple: async (model, context, options) =>
      scripted.completeSimple(model, context, options),
  };
  return { models, requested, signals };
}

/**
 * A model layer that answers the script, but only after a delay.
 *
 * Steering needs a run that is *in flight* while the test talks to it, and a scripted model answers
 * before the caller can do anything. The delay is that window; `requested` says when a turn has
 * actually begun, so the test never has to guess with a timer of its own.
 *
 * The stream is pumped rather than returned late: `streamSimple` has to hand back pi-ai's stream
 * object synchronously, so the waiting happens inside it.
 */
export function delayedModels(
  answers: AssistantMessage[],
  delayMs = 150,
): { models: KernelModels; requested: () => Promise<void> } {
  const scripted = fakeModels(answers);
  let resolveTurn!: () => void;
  let turn = new Promise<void>((resolve) => {
    resolveTurn = resolve;
  });
  const arm = (): void => {
    turn = new Promise<void>((resolve) => {
      resolveTurn = resolve;
    });
  };
  return {
    requested: () => turn,
    models: {
      getModel: (provider, id) => scripted.getModel(provider, id),
      streamSimple: (model, context, options) => {
        resolveTurn();
        const out = createAssistantMessageEventStream();
        void (async () => {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          arm();
          const inner = scripted.streamSimple(model, context, options);
          for await (const event of inner) out.push(event);
          out.end(await inner.result());
        })();
        return out;
      },
      completeSimple: async (model, context, options) =>
        scripted.completeSimple(model, context, options),
    },
  };
}
