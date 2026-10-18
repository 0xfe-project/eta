import type { paths as ControlPlanePaths } from "@/api/control-plane.gen";
// Browser clients for the old same-origin REST API that has not moved to the wire yet: the
// control plane (/api/v1, for bundles and computers) and its GitHub connection under
// /api/forge/v1. POSTs carry an Idempotency-Key so a retried request cannot run twice.
//
// The control plane's client is typed by a frozen OpenAPI snapshot (`bun run generate` writes
// src/api from openapi/compat.json; redocly.yaml lists it). Each client goes when its feature
// moves to @eta/client-contracts.

import createClient from "openapi-fetch";
import { translate } from "@/lib/i18n";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const fallbackMessage = () => translate("common:errors.requestFailed");

async function parse(response: Response) {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = body?.error;
    throw new ApiError(
      response.status,
      error?.code ?? "UNKNOWN",
      error?.message ?? fallbackMessage(),
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

export const forgeApi = client("/api/forge/v1");

/** A service's client, typed by its OpenAPI document. */
function typedClient<Paths extends object>() {
  const client = createClient<Paths>({
    // Looked up per request, so tests can replace it.
    fetch: (request) => globalThis.fetch(request),
  });
  client.use({
    onRequest({ request }) {
      if (request.method === "POST" && !request.headers.has("Idempotency-Key"))
        request.headers.set("Idempotency-Key", crypto.randomUUID());
      return request;
    },
  });
  return client;
}

export const controlPlane = typedClient<ControlPlanePaths>();

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
      body.error?.message ?? fallbackMessage(),
    );
  }
  return data as T;
}
