/**
 * Counting every generation (REFACTOR.md §9, P1.3).
 *
 * The proxy sits between the kernel and the providers, which is the one place where everything a
 * row needs is present at once: which session asked (the subject, captured when that session
 * opened), which provider and model answered, and what it cost.
 *
 * It also sees what the journal cannot: a generation that failed never produced a usage row, and
 * "which provision is failing" is a question this table is supposed to answer.
 */
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { KernelModels } from "@eta/core";
import type { UsageStore } from "./store";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";

export interface RecordingOptions {
  store: UsageStore;
  /** Who this session counts as: the agent id when there is one, else the session. */
  subject: string;
}

/**
 * The subject a session's usage is counted under.
 *
 * P2.2 puts an `agentId` in a session's metadata when the session belongs to an agent in a group;
 * until then a session counts under its own id, which is still an honest answer to "who spent
 * this".
 */
/** The text of whatever was thrown, for a row that says why. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A settled, empty assistant message that says the request failed.
 *
 * The kernel reads a generation by its settled message, so a failure that arrives as a throw has to
 * be turned into one of these rather than into a stream that simply ends.
 */
function failedMessage(model: Model<Api>, error: unknown): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  };
}

export function subjectOf(meta: { id: string; agentId?: unknown }): string {
  const agentId = meta.agentId;
  return typeof agentId === "string" && agentId.length > 0
    ? agentId
    : `session:${meta.id}`;
}

export function recordingModels(
  inner: KernelModels,
  options: RecordingOptions,
): KernelModels {
  const record = (
    message: AssistantMessage | undefined,
    failed: boolean,
    error?: string | undefined,
  ): void => {
    options.store.record({
      subject: options.subject,
      provider: message?.provider ?? "unknown",
      model: message?.model ?? "unknown",
      failed,
      at: new Date(),
      ...(message === undefined ? {} : { usage: message.usage }),
      // The provider's own words, so a settings page can tell a rate limit from a bad key.
      ...(error === undefined ? {} : { error }),
    });
  };

  return {
    getModel: (provider, id) => inner.getModel(provider, id),

    completeSimple: async (model, context, streamOptions) => {
      try {
        const message = await inner.completeSimple(
          model,
          context,
          streamOptions,
        );
        record(
          message,
          message.stopReason === "error" || message.stopReason === "aborted",
        );
        return message;
      } catch (error) {
        record(undefined, true);
        throw error;
      }
    },

    /**
     * The stream is pumped through one of pi-ai's own, rather than handed over wrapped: the
     * consumer may iterate it or ask for its result, and a hand-rolled object would have to
     * pretend to be both.
     */
    streamSimple: (model, context, streamOptions) => {
      let source: ReturnType<typeof inner.streamSimple>;
      try {
        source = inner.streamSimple(model, context, streamOptions);
      } catch (error) {
        // A provider (or a script) can refuse before there is a stream at all.
        record(undefined, true);
        throw error;
      }
      const out = createAssistantMessageEventStream();
      void (async () => {
        try {
          for await (const event of source) {
            out.push(event);
            if (event.type === "done") record(event.message, false);
            if (event.type === "error") record(event.error, true);
          }
          const settled = await source.result();
          if (settled === undefined) {
            // A provider that closes without producing a message. Ending the stream here would
            // leave the kernel waiting for a result that never comes.
            const failure = failedMessage(
              model,
              new Error("the provider ended without a result"),
            );
            record(undefined, true, failure.errorMessage);
            out.push({ type: "error", reason: "error", error: failure });
            return;
          }
          out.end(settled);
        } catch (error) {
          // A provider that throws before it produces a message — a network failure, or the abort
          // cancelling its read. The generation still happened and is still counted, and the kernel
          // has to be told how it ended: an error *event* settles the stream, while `end(undefined)`
          // leaves pi-ai's result pending forever, which is a run that never ends. The kernel reads
          // this as a cancellation when its own signal fired, and as a failure when it did not.
          record(undefined, true, reasonOf(error));
          out.push({
            type: "error",
            // pi-ai tells the two apart for us, and the kernel makes the same distinction: a
            // provider that stopped because this run's signal fired did not fail.
            reason:
              streamOptions?.signal?.aborted === true ? "aborted" : "error",
            error: failedMessage(model, error),
          });
        }
      })();
      return out;
    },
  };
}
