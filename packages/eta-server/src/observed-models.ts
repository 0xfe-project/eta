/**
 * A model layer that says what it was asked.
 *
 * Every request a session makes goes through its `KernelModels`: a turn, each retry of a turn, a
 * compaction's summary, a side question, a memory extraction, a subagent's turns. Watching the
 * layer rather than the session's turn events is what makes the count complete: those are the
 * only place a request that failed and was tried again, or one that is not a turn, is visible.
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { KernelModels } from "@eta/core";

/** Told, for each request, how it ended. A request that threw before it started has no message. */
export type GenerationObserver = (message: AssistantMessage) => void;

export function observedModels(
  models: KernelModels,
  observe: GenerationObserver,
): KernelModels {
  const told = (message: AssistantMessage): void => {
    try {
      observe(message);
    } catch {
      // Counting must never be the reason a generation fails.
    }
  };
  return {
    getModel: (provider, id) => models.getModel(provider, id),
    streamSimple: (model, context, options) => {
      const stream = models.streamSimple(model, context, options);
      void stream.result().then(told, () => undefined);
      return stream;
    },
    completeSimple: async (model, context, options) => {
      const message = await models.completeSimple(model, context, options);
      told(message);
      return message;
    },
  };
}
