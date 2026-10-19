/**
 * A model layer that answers by looking at the request.
 *
 * The host's tests have several agents answering at once, in an order nobody controls, so a script
 * that is a list cannot say who gets which answer. This one is a function of the request: which
 * agent is asking (read from the system prompt), what the conversation looks like, and how many
 * requests there have been. An answer is a settled assistant message; a promise holds the
 * request until the test lets it go (a turn that is in flight while the test talks to it), and
 * `HANG` is a provider that says nothing until the run is aborted.
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { KernelModels } from "@eta/core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { assistantMessage, fakeModels } from "@eta/core/testing";

export const HANG = Symbol("hang");

export interface Request {
  /** The agent asking, from "In this conversation you are <name>" in its system prompt. */
  agent: string | undefined;
  system: string;
  /** The text of every message the request carries, oldest first, as `role: text`. */
  transcript: string[];
  /** The text of the last message, and its role. */
  last: string;
  lastRole: string;
  /** Which request this is, overall, from zero. */
  index: number;
  /** The names of the tools it offers. */
  tools: string[];
  /** How many images the messages carry, in all. */
  images: number;
}

export type Answer = AssistantMessage | typeof HANG;

export const say = (text: string, thinking?: string): AssistantMessage =>
  assistantMessage({
    content: [
      ...(thinking === undefined
        ? []
        : [{ type: "thinking" as const, thinking }]),
      { type: "text" as const, text },
    ],
  });

export const call = (
  name: string,
  args: Record<string, unknown>,
  id = `call-${name}-${Math.random().toString(36).slice(2, 8)}`,
): AssistantMessage =>
  assistantMessage({
    stopReason: "toolUse",
    content: [{ type: "toolCall", id, name, arguments: args }],
  });

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: { type?: string; text?: string }) =>
      block.type === "text" ? (block.text ?? "") : "",
    )
    .join("");
}

/** A stream that yields nothing until `signal` fires, then ends the way a cancelled read does. */
function waiting(signal: AbortSignal | undefined): unknown {
  const fired = new Promise<void>((resolve) => {
    if (signal?.aborted === true) resolve();
    else signal?.addEventListener("abort", () => resolve(), { once: true });
  });
  return {
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

export function scriptedModels(
  respond: (request: Request) => Answer | Promise<Answer>,
  options: { vision?: boolean } = {},
): { models: KernelModels; requests: Request[] } {
  const requests: Request[] = [];
  const base = fakeModels([]);
  const models: KernelModels = {
    getModel: (provider, id) => {
      const model = base.getModel(provider, id);
      return options.vision === true && model !== undefined
        ? ({ ...model, input: ["text", "image"] } as typeof model)
        : model;
    },
    streamSimple: (model, context, options) => {
      const system = context.systemPrompt ?? "";
      const messages = context.messages as {
        role: string;
        content?: unknown;
      }[];
      const last = messages.at(-1);
      const request: Request = {
        agent: /In this conversation you are ([^.]+)\./.exec(system)?.[1],
        system,
        transcript: messages.map(
          (message) => `${message.role}: ${textOf(message.content)}`,
        ),
        last: textOf(last?.content),
        lastRole: last?.role ?? "",
        index: requests.length,
        tools: (context.tools ?? []).map((tool) => tool.name),
        images: messages.reduce(
          (count, message) =>
            count +
            (Array.isArray(message.content)
              ? message.content.filter(
                  (block: { type?: string }) => block.type === "image",
                ).length
              : 0),
          0,
        ),
      };
      requests.push(request);
      const answer = respond(request);
      if (answer === HANG) return waiting(options?.signal) as never;
      const out = createAssistantMessageEventStream();
      void (async () => {
        const settled = await answer;
        if (settled === HANG) return;
        const inner = fakeModels([settled]).streamSimple(
          model,
          context,
          options,
        );
        for await (const event of inner) out.push(event);
        out.end(await inner.result());
      })();
      return out;
    },
    completeSimple: async (model, context, options) => {
      const settled = await respond({
        agent: undefined,
        system: context.systemPrompt ?? "",
        transcript: [],
        last: "",
        lastRole: "",
        index: requests.length,
        tools: [],
        images: 0,
      });
      if (settled === HANG) throw new Error("hang");
      return fakeModels([settled]).completeSimple(model, context, options);
    },
  };
  return { models, requests };
}

/** A promise a test settles by hand: the turn that is in flight until it is let go. */
export function gate(): { open: () => void; opened: Promise<void> } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}
