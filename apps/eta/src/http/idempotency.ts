/**
 * Idempotency keys: a POST that carries `Idempotency-Key` runs once, however many times it is
 * retried (REFACTOR.md §9, P0.5).
 *
 * What is stored is the response, and what is replayed is that response — the handler does not
 * run again, so no second message is sent, no second task is created. Only JSON responses with
 * a status below 500 are stored: a 500 is the server saying "ask again", and a stream is not a
 * thing that can be replayed at all.
 *
 * One limit worth stating plainly: the handler's own writes and this record are not yet one
 * transaction. A crash in the window between them means the retry runs the handler a second
 * time. Making them atomic is the job of the endpoint whose write must be exactly-once (P2's
 * message send, where the message row and the key are written together) — the seam is here.
 */
import type { Database } from "bun:sqlite";

export interface StoredResponse {
  status: number;
  contentType: string | null;
  body: string;
}

interface Row {
  status: number;
  content_type: string | null;
  body: string;
}

export class IdempotencyStore {
  readonly handle: Database;

  constructor(handle: Database) {
    this.handle = handle;
  }

  readonly get: (key: string) => StoredResponse | undefined = (key) => {
    const row = this.handle
      .query(
        "SELECT status, content_type, body FROM http_idempotency WHERE key = ?",
      )
      .get(key) as Row | null;
    if (row === null) return undefined;
    return {
      status: row.status,
      contentType: row.content_type,
      body: row.body,
    };
  };

  readonly put: (
    key: string,
    method: string,
    path: string,
    response: StoredResponse,
  ) => void = (key, method, path, response) => {
    this.handle
      .query(
        `INSERT OR REPLACE INTO http_idempotency
				   (key, method, path, status, content_type, body, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        key,
        method,
        path,
        response.status,
        response.contentType,
        response.body,
        new Date().toISOString(),
      );
  };

  readonly count: () => number = () =>
    (
      this.handle.query("SELECT COUNT(*) AS n FROM http_idempotency").get() as {
        n: number;
      }
    ).n;
}

/** The client's name for this request: its own id, sent so a retry is recognisable. */
function idempotencyKeyOf(request: Request): string | undefined {
  const key = request.headers.get("idempotency-key");
  return key === null || key.length === 0 ? undefined : key;
}

const replayable = (response: Response): boolean =>
  response.status < 500 &&
  (response.headers.get("content-type") ?? "").includes("application/json");

/**
 * Run a request through the key, if it has one.
 *
 * A replay is marked with `x-idempotent-replay: true`, so a caller (and a test) can tell "this
 * was the stored answer" from "this was computed just now".
 */
export async function withIdempotency(
  store: IdempotencyStore,
  request: Request,
  run: () => Promise<Response>,
): Promise<Response> {
  if (request.method !== "POST") return run();
  const key = idempotencyKeyOf(request);
  if (key === undefined) return run();

  const stored = store.get(key);
  if (stored !== undefined) {
    const headers = new Headers({ "x-idempotent-replay": "true" });
    if (stored.contentType !== null)
      headers.set("content-type", stored.contentType);
    return new Response(stored.body, { status: stored.status, headers });
  }

  const response = await run();
  // `clone` first: reading the body would consume the response we are about to return.
  if (replayable(response)) {
    const body = await response.clone().text();
    store.put(key, request.method, new URL(request.url).pathname, {
      status: response.status,
      contentType: response.headers.get("content-type"),
      body,
    });
  }
  return response;
}
