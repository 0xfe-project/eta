import type { IncomingMessage, ServerResponse } from "node:http";

/** App-owned HTTP routes that are not static files or the SPA shell. */
export function ownsWebApi(pathname: string): boolean {
  return pathname === "/up" || pathname === "/version";
}

export async function handleWebApi(
  request: Request,
  buildId: string,
): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (pathname === "/up") return new Response("ok");
  if (pathname === "/version" && request.method === "GET") {
    return new Response(buildId, {
      headers: { "Cache-Control": "no-store" },
    });
  }
  return null;
}

async function fromNodeRequest(req: IncomingMessage): Promise<Request> {
  const host = req.headers.host ?? "localhost";
  const url = `http://${host}${req.url ?? "/"}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  const method = req.method ?? "GET";
  if (method === "GET" || method === "HEAD") {
    return new Request(url, { method, headers });
  }
  const chunks: Uint8Array[] = [];
  for await (const chunk of req) {
    chunks.push(
      typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk,
    );
  }
  const length = chunks.reduce((n, part) => n + part.byteLength, 0);
  const body = new Uint8Array(length);
  let offset = 0;
  for (const part of chunks) {
    body.set(part, offset);
    offset += part.byteLength;
  }
  return new Request(url, { method, headers, body });
}

async function writeNodeResponse(res: ServerResponse, response: Response) {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });
  res.end(new Uint8Array(await response.arrayBuffer()));
}

export function webApiMiddleware(buildId: () => string) {
  return (
    req: IncomingMessage,
    res: ServerResponse,
    next: (error?: unknown) => void,
  ) => {
    // Paths this does not answer are left untouched — including their bodies. Draining a
    // request it will not answer would hand the next middleware an empty stream, and the
    // thing after it (the dev proxy) would forward headers with no body under them.
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (!ownsWebApi(pathname)) {
      next();
      return;
    }
    void (async () => {
      try {
        const response = await handleWebApi(
          await fromNodeRequest(req),
          buildId(),
        );
        if (!response) {
          next();
          return;
        }
        await writeNodeResponse(res, response);
      } catch (error) {
        next(error);
      }
    })();
  };
}
