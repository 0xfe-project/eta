-- Why a generation failed (REFACTOR.md §9, P1.4).
--
-- `failed` alone answers "how many"; the reason is what a settings page needs to say *why* — a
-- provider answering 429 is rate limiting us, one answering 401 is a key nobody will fix by
-- waiting, and an endpoint that is down is neither. The text is the provider's own message, kept
-- as it came: whoever reads it can tell the three apart, and this host does not have to guess.
ALTER TABLE usage_hourly ADD COLUMN error TEXT;
