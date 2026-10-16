-- Usage, by the hour (REFACTOR.md §9, P1.3).
--
-- Who used what, not what a subscription window says: a provider tells you how much *an account*
-- has spent, and nothing about who spent it. So every generation is counted here, per subject,
-- provider and model, and summed per hour — which keeps the table small and still answers "what
-- did the reviewer agent cost me this week, and on which model".
--
-- The per-request rows are not lost: the journal already holds one per generation (the harness's
-- usage rows). This table is the aggregate a settings page reads.
CREATE TABLE usage_hourly (
  -- The agent id when the session knows one (P2.2 puts it in the meta), else `session:<id>`.
  subject TEXT NOT NULL,
  -- One entry in the config file is one account: the provider id is the account.
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  -- The hour this belongs to, as `YYYY-MM-DDTHH` in UTC.
  hour TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  input INTEGER NOT NULL DEFAULT 0,
  output INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  reasoning INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (subject, provider, model, hour)
);

-- The read is "this subject over the last N hours"; the write is the primary key's upsert.
CREATE INDEX usage_hourly_hour ON usage_hourly (hour);
