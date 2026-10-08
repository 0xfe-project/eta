// Browser clients for the same-origin API behind the edge gateway: the
// control plane (/api/v1), the LLM gateway (/api/llm/v1), the memory
// service (/api/memory/v1) and the forge service (/api/forge/v1).
// POSTs carry an Idempotency-Key so a retried request cannot run twice.
//
// The control plane's client is typed by its OpenAPI document, which is
// generated from its code (`bun run generate` writes src/api).

import type { paths } from "@/api/control-plane.gen";
import createClient from "openapi-fetch";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const FALLBACK_MESSAGE = "请求失败，请稍后再试。";

async function parse(response: Response) {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = body?.error;
    throw new ApiError(
      response.status,
      error?.code ?? "UNKNOWN",
      error?.message ?? FALLBACK_MESSAGE,
    );
  }
  return body;
}

function client(base: string) {
  return {
    async get(path: string, signal?: AbortSignal) {
      return parse(await fetch(`${base}${path}`, { signal }));
    },
    async post(
      path: string,
      body: unknown = {},
      idempotencyKey: string = crypto.randomUUID(),
    ) {
      return parse(
        await fetch(`${base}${path}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify(body),
        }),
      );
    },
    async patch(path: string, body: unknown) {
      return parse(
        await fetch(`${base}${path}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    },
    async delete(path: string) {
      const response = await fetch(`${base}${path}`, { method: "DELETE" });
      if (!response.ok) await parse(response);
    },
  };
}

export const llmApi = client("/api/llm/v1");
export const memoryApi = client("/api/memory/v1");
export const forgeApi = client("/api/forge/v1");

/** The control plane, typed by its OpenAPI document. */
export const controlPlane = createClient<paths>({
  // Looked up per request, so tests can replace it.
  fetch: (request) => globalThis.fetch(request),
});

controlPlane.use({
  onRequest({ request }) {
    if (request.method === "POST" && !request.headers.has("Idempotency-Key"))
      request.headers.set("Idempotency-Key", crypto.randomUUID());
    return request;
  },
});

/** The response's data, or its error envelope as an ApiError. */
export async function unwrap<T>(
  result: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
  const { data, error, response } = await result;
  if (!response.ok) {
    const body = (error ?? {}) as {
      error?: { code?: string; message?: string };
    };
    throw new ApiError(
      response.status,
      body.error?.code ?? "UNKNOWN",
      body.error?.message ?? FALLBACK_MESSAGE,
    );
  }
  return data as T;
}
