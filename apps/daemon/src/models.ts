/**
 * The model layer of a machine that has no providers.
 *
 * A daemon holds no provider keys and no Codex credentials. A session's kernel still wants a
 * `KernelModels`, so this is one whose generation is a call to the primary, over the link: the
 * primary resolves the model, adds the credentials, streams from the provider and sends each event
 * back as it arrives. Usage is therefore counted where the keys are, and a key never crosses the
 * link in either direction.
 *
 * Resolving a model (`getModel`) is synchronous in the kernel's seam, so the daemon cannot ask for
 * it: the primary sends the definition of the model a session uses when it opens the session
 * (`catalog.add`), with nothing in it that reaches a provider.
 */
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ModelSpec } from "@eta/client-contracts";
import type { KernelModels } from "@eta/core";
import type { Peer } from "./link/peer";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { LINK_LIMITS } from "@eta/client-contracts";

/** The models the daemon has been told about, by `provider:id`. */
export class ModelCatalog {
  readonly #models = new Map<string, Model<Api>>();

  add(spec: ModelSpec): void {
    const { provider, id } = spec.lookup ?? spec;
    this.#models.set(`${provider}:${id}`, spec as never);
  }

  get(provider: string, id: string): Model<Api> | undefined {
    return this.#models.get(`${provider}:${id}`);
  }
}

/** A model definition fit to leave the primary: whatever reaches a provider is taken out. */
export function modelSpecOf(
  model: Model<Api>,
  lookup?: { provider: string; id: string },
): ModelSpec {
  const { headers: _headers, baseUrl: _baseUrl, ...rest } = model;
  return {
    ...rest,
    baseUrl: "",
    ...(lookup === undefined ? {} : { lookup }),
  } as unknown as ModelSpec;
}

/**
 * The options that survive the trip: the ones that shape a request. Credentials, headers,
 * callbacks and the abort signal (which travels as a cancel) are the primary's own.
 */
const FORWARDED_OPTIONS = [
  "temperature",
  "maxTokens",
  "reasoning",
  "thinkingBudgets",
  "cacheRetention",
  "sessionId",
  "toolChoice",
  "samplingParams",
  "transport",
] as const;

export function forwardedOptions(
  options: SimpleStreamOptions | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (options === undefined) return out;
  for (const key of FORWARDED_OPTIONS) {
    const value = (options as Record<string, unknown>)[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** A failed generation, as the provider would have reported it. */
function failure(
  model: Model<Api>,
  reason: "error" | "aborted",
  message: string,
): AssistantMessage {
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
    stopReason: reason,
    errorMessage: message,
    timestamp: Date.now(),
  };
}

/**
 * The model layer for one session. `peer` is read at every call, because the link comes and goes
 * and a session outlives it: a generation started with no link fails the way a provider outage
 * does, and the run says why.
 */
export function remoteModels(options: {
  session: string;
  catalog: ModelCatalog;
  peer: () => Peer | undefined;
}): KernelModels {
  const stream = (
    model: Model<Api>,
    context: Context,
    streamOptions?: SimpleStreamOptions,
  ) => {
    const out = createAssistantMessageEventStream();
    const peer = options.peer();
    const abortedAlready = streamOptions?.signal?.aborted === true;
    const finish = (reason: "error" | "aborted", message: string): void => {
      const error = failure(model, reason, message);
      out.push({ type: "error", reason, error });
    };
    if (peer === undefined || peer.lost) {
      finish(
        "error",
        "the primary is not reachable, so there is no model to generate with",
      );
      return out;
    }
    if (abortedAlready) {
      finish("aborted", "aborted");
      return out;
    }
    void peer
      .call(
        "model.stream",
        {
          session: options.session,
          model: { provider: model.provider, id: model.id },
          context,
          options: forwardedOptions(streamOptions),
        },
        {
          timeoutMs: LINK_LIMITS.runTimeoutMs,
          ...(streamOptions?.signal === undefined
            ? {}
            : { signal: streamOptions.signal }),
          onEvent: (event) => out.push(event as AssistantMessageEvent),
        },
      )
      .then(
        () => {
          // The provider's own last event ends the stream; this only covers one that ended
          // without it.
          out.end();
        },
        (error: unknown) => {
          const message =
            error instanceof Error ? error.message : String(error);
          const aborted = streamOptions?.signal?.aborted === true;
          finish(aborted ? "aborted" : "error", message);
        },
      );
    return out;
  };
  return {
    getModel: (provider, id) =>
      options.catalog.get(provider as string, id as string) as never,
    streamSimple: ((model, context, streamOptions) =>
      stream(model, context, streamOptions)) as KernelModels["streamSimple"],
    completeSimple: (async (model, context, streamOptions) =>
      await stream(
        model,
        context,
        streamOptions as SimpleStreamOptions,
      ).result()) as KernelModels["completeSimple"],
  };
}
