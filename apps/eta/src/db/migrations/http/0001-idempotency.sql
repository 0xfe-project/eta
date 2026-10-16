-- Idempotency keys (REFACTOR.md §9, P0.5).
--
-- A POST that carries `Idempotency-Key` runs once however many times it is retried: the first
-- response is stored and replayed. The key is the client's (a message id, a form submission), so
-- a retry after a timeout and a resend after a reload are the same request.
CREATE TABLE http_idempotency (
  key TEXT PRIMARY KEY,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  status INTEGER NOT NULL,
  content_type TEXT,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
