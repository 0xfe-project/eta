/**
 * A fake Codex backend and the gateway wired to it.
 *
 * What it answers depends on the prompt the request carries: `fail-500` and `fail-429` fail,
 * `slow` streams until the client goes away (and counts that), anything else streams a short
 * answer of four deltas with usage. CPA reaches it as a Codex API key whose base URL is this
 * server, so the whole path (CPA's routing, its Responses translation, the stream back out) is
 * the real one.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGateway } from "../src/index";

export const MODEL = "gpt-test";

export interface FakeUpstream {
  readonly url: string;
  requests: number;
  /** Streams whose client went away before the end. */
  cancelled: number;
  stop: () => void;
}

const encoder = new TextEncoder();

function event(name: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function fakeUpstream(): FakeUpstream {
  const state = { requests: 0, cancelled: 0 };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    // A "slow" stream is open as long as the client stays; do not time it out.
    idleTimeout: 0,
    async fetch(request) {
      state.requests += 1;
      const prompt = await request.text();
      if (prompt.includes("fail-500"))
        return Response.json({ error: { message: "boom" } }, { status: 500 });
      if (prompt.includes("fail-429")) {
        return Response.json(
          { error: { type: "usage_limit_reached", message: "slow down" } },
          { status: 429, headers: { "retry-after": "1" } },
        );
      }
      const slow = prompt.includes("slow");
      const words = ["Hello", " from", " the", " fake"];
      const text = words.join("");
      const response = {
        id: "resp_1",
        object: "response",
        created_at: 1,
        status: "in_progress",
        model: MODEL,
        output: [] as unknown[],
      };
      const delta = (value: string) =>
        event("response.output_text.delta", {
          type: "response.output_text.delta",
          item_id: "msg_1",
          output_index: 0,
          content_index: 0,
          delta: value,
        });
      let timer: ReturnType<typeof setInterval> | undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            event("response.created", { type: "response.created", response }),
          );
          controller.enqueue(
            event("response.output_item.added", {
              type: "response.output_item.added",
              output_index: 0,
              item: {
                type: "message",
                id: "msg_1",
                role: "assistant",
                status: "in_progress",
                content: [],
              },
            }),
          );
          controller.enqueue(
            event("response.content_part.added", {
              type: "response.content_part.added",
              item_id: "msg_1",
              output_index: 0,
              content_index: 0,
              part: { type: "output_text", text: "" },
            }),
          );
          if (slow) {
            let i = 0;
            timer = setInterval(() => {
              controller.enqueue(delta(` ${i++}`));
            }, 20);
            return;
          }
          for (const word of words) controller.enqueue(delta(word));
          const done = {
            type: "message",
            id: "msg_1",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text, annotations: [] }],
          };
          controller.enqueue(
            event("response.output_text.done", {
              type: "response.output_text.done",
              item_id: "msg_1",
              output_index: 0,
              content_index: 0,
              text,
            }),
          );
          controller.enqueue(
            event("response.output_item.done", {
              type: "response.output_item.done",
              output_index: 0,
              item: done,
            }),
          );
          controller.enqueue(
            event("response.completed", {
              type: "response.completed",
              response: {
                ...response,
                status: "completed",
                output: [done],
                usage: { input_tokens: 5, output_tokens: 4, total_tokens: 9 },
              },
            }),
          );
          controller.close();
        },
        cancel() {
          if (timer !== undefined) clearInterval(timer);
          state.cancelled += 1;
        },
      });
      return new Response(body, {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    get requests() {
      return state.requests;
    },
    get cancelled() {
      return state.cancelled;
    },
    stop: () => void server.stop(true),
  } as FakeUpstream;
}

/** CPA's config for the fake as a Codex API key serving `MODEL`. */
export function cpaExtraFor(upstream: FakeUpstream): Record<string, unknown> {
  return {
    "codex-api-key": [
      {
        "api-key": "test-key",
        "base-url": upstream.url,
        models: [{ name: MODEL, alias: MODEL }],
      },
    ],
  };
}

/** The gateway on a fresh state directory, wired to the fake, once it serves `MODEL`. */
export async function gatewayOn(upstream: FakeUpstream) {
  const gateway = startGateway({
    stateDir: mkdtempSync(join(tmpdir(), "llm-gateway-")),
    cpaExtra: cpaExtraFor(upstream),
  });
  // /v1 answers 503 until the credentials are loaded.
  const deadline = Date.now() + 30_000;
  for (;;) {
    const response = await gateway.fetch("/v1/models");
    if (response.ok && (await response.text()).includes(MODEL)) return gateway;
    if (Date.now() > deadline)
      throw new Error(`the gateway never served ${MODEL}`);
    await Bun.sleep(50);
  }
}

/** One streamed chat completion; resolves with the text it carried. */
export async function chat(
  gateway: { fetch: (path: string, init?: RequestInit) => Promise<Response> },
  prompt: string,
  signal?: AbortSignal,
): Promise<{ status: number; text: string }> {
  const response = await gateway.fetch("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      stream: true,
      messages: [{ role: "user", content: prompt }],
    }),
    ...(signal === undefined ? {} : { signal }),
  });
  return { status: response.status, text: await response.text() };
}
