// Browser clients for the same-origin API behind the edge gateway: the
// control plane (/api/v1) and the LLM gateway (/api/llm/v1).
// POSTs carry an Idempotency-Key so a retried request cannot run twice.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function parse(response: Response) {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = body?.error;
    throw new ApiError(
      response.status,
      error?.code ?? "UNKNOWN",
      error?.message ?? "请求失败，请稍后再试。",
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

const controlPlane = client("/api/v1");
export const llmApi = client("/api/llm/v1");

export const apiGet = controlPlane.get;
export const apiPost = controlPlane.post;
export const apiPatch = controlPlane.patch;
export const apiDelete = controlPlane.delete;
