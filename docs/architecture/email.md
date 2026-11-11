# Mailbox

The mailbox is a standalone email channel, not an appendage of the agent, and not part of the existing `inbox` (the agent question queue).

## Data boundaries

```text
email_account
  └─ email_thread
       ├─ email_message
       ├─ session_email ── session (unmodified)
       └─ email_proposal
```

- `email_account` only stores the protocol address and connection parameters; the authorization code is stored in the `credential` table with `integration='email'` and encapsulated with the host machine's `secret.key`.
- `email_thread` and `email_message` store mail threads, RFC 5322 headers, and human-readable bodies.
- `session_email` is a product-level many-to-many relationship between regular sessions and mail threads. It is not session ownership: deleting a session does not delete the email.
- `email_proposal` is a pending-confirmation widget created by the `send_email` / `reply` tools. Before the user confirms, it does not enter SMTP or get written to sent mail.

## Receiving mail

Receiving mail uses IMAP only. INBOX is checked every 60 seconds, and the spam directory is checked via IMAP special-use `\Junk` or explicit configuration. On first binding, the cursor is set to the current latest UID; the full mailbox history is not imported.

The “Check connection” button on the settings page performs SMTP login, IMAP login, and read-only confirmation that the inbox and spam directory are accessible. It does not send a test email or verify ownership of the email address; actual send/receive verification is done by SMTP/IMAP integration tests and end-to-end tests between two instances. When editing an account, leaving the password blank continues to use the already encapsulated credential.

Receiving new email only updates mailbox state and **does not create or wake an agent**. Only after the user selects a thread on the mailbox page and explicitly chooses an agent and project is an email briefing written to that agent's real direct chat, a regular session started, and `session_email` written. The mailbox page displays the handling agent, project, run status, and final result, and can open that session directly.

On the mailbox page, “Inbox” lists only threads containing received mail, and “Sent” lists only threads containing sent mail. Subsequent sends and receives in the same thread remain together so the full reply chain can be viewed.

A session can be associated with multiple emails. When handed to an agent, the email subject, body, RFC 5322 headers, and decoded ETA meta enter the first prompt.

## Sending mail

Agents only create pending-confirmation proposals:

- `send_email`: a new email; the mailbox account must be explicitly selected.
- `reply`: can only reply to a thread already associated with the current session; the parameters carry `threadId`.

Proposals appear as editable widgets in the session timeline. Only after the user confirms:

1. Generate a Message-ID of `<eta.{uuid}.{session-id}@domain>`.
2. Generate the `In-Reply-To` and `References` needed for the reply.
3. Render the Markdown/HTML email, logo, and 10×10 context data points.
4. Write to the outbox and send via SMTP.
5. Record `sending → accepted / failed`.

SMTP accepted only means the server accepted it, not that the recipient has read it.

## ETA context

The logo's `alt` uses `ETA-A1:<base64url-json>`, carrying `agentId`, `agentName`, `sessionId`, logical session / mail thread id, and task id.

Each 10×10 data point in the body carries an `alt` fragment:

```text
ETA1:<batch>:<index>/<count>:<sha256-8>:<base64url-gzip-json>
```

After merging the fragments, the receiver restores the full envelope, which contains the agent/session/task identifiers and `context`. The seven data points are not seven independent contexts, but fragments of the same gzip data; the number of fragments only represents transmission volume. The mailbox page displays the decoded summary by default and can expand the full `context` on demand. Data points do not automatically trigger any agent action.

Regular emails always display 7 10×10 data points and divide the compressed context data as evenly as possible among these 7 `alt` fields. The number of points is increased only when the total data exceeds the capacity of 7 `alt` fields, to avoid truncating the context.

`context` is optional business data for the send tool. When the sender passes `{}` or omits it, the email still carries the logo and the agent/session/thread/task metadata in the fragments, but the page displays “no additional context”; this does not mean fragment decoding failed.
