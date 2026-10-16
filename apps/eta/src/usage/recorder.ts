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
import type { AssistantMessage } from "@earendil-works/pi-ai";
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
  ): void => {
    options.store.record({
      subject: options.subject,
      provider: message?.provider ?? "unknown",
      model: message?.model ?? "unknown",
      failed,
      at: new Date(),
      ...(message === undefined ? {} : { usage: message.usage }),
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
          out.end(await source.result());
        } catch (error) {
          // A provider that throws before it produces a message: the generation still happened,
          // and the kernel still gets an ended stream (which is how it reports the failure).
          record(undefined, true);
          out.end(undefined);
          void error;
        }
      })();
      return out;
    },
  };
}
