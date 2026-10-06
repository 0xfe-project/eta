// Browser client for the control plane's public API (/api/v1).
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

export async function apiGet(path: string, signal?: AbortSignal) {
  return parse(await fetch(`/api/v1${path}`, { signal }));
}

export async function apiPost(
  path: string,
  body: unknown = {},
  idempotencyKey: string = crypto.randomUUID(),
) {
  return parse(
    await fetch(`/api/v1${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(body),
    }),
  );
}

export async function apiPatch(path: string, body: unknown) {
  return parse(
    await fetch(`/api/v1${path}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

export async function apiDelete(path: string) {
  const response = await fetch(`/api/v1${path}`, { method: "DELETE" });
  if (!response.ok) await parse(response);
}
