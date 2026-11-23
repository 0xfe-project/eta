-- There is no email any more: the mailbox, its threads, the agents' proposed sends and the
-- password each account was signed in with all go.
--
-- 0037 stays, and makes these tables on a new database only for this to drop them again: a
-- migration's file name is its id in `eta_migrations`, and an upgrade refuses a build that does not
-- carry every id the database has applied (`upgrade.ts`, "It is ahead of that build"), so taking
-- 0037 out would stop every host that ran it from upgrading to this one.
--
-- The tables only reference each other, so dropping them leaves nothing that points at them;
-- children go first all the same. The rows a mailbox's password was sealed in are the
-- `credential` table's, under `integration = 'email'`; MCP's rows there stay.
DROP TABLE IF EXISTS email_proposal;
DROP TABLE IF EXISTS session_email;
DROP TABLE IF EXISTS email_cursor;
DROP TABLE IF EXISTS email_message;
DROP TABLE IF EXISTS email_thread;
DROP TABLE IF EXISTS email_account;
DELETE FROM credential WHERE integration = 'email';
