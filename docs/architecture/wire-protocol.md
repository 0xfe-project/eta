# Wire protocol and target

There is only one WebSocket (`/ws`) between the browser and the host, speaking the upstream pipe protocol (`packages/client-wire-proto`). The server is a pipe: calls come in; replies, state, and events go out. The server does not know any feature names; what can be called is determined by what is registered at the time and is announced in `hello`.

## Frames

| Direction | Frame                                             | Meaning                                                                                               |
| ---- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| In   | `call { target, action, args?, requestId? }`   | Call `target.action`; a reply is sent only if `requestId` is present, otherwise no reply (cheap fire-and-forget)                |
| In   | `subscribe { target, filter? }`                | Subscribe to a target's state and events; `filter` only filters event names (substring); state is always the full snapshot                          |
| In   | `unsubscribe { target }`                       | Unsubscribe                                                                                           |
| In   | `native`                                       | Desktop shell loopback; not used by eta                                                                           |
| Out   | `hello { ops, mounted, state }`                | First frame after connecting (sent again after reconnect): all callable ops and their contracts, mounted plugins, and the state of all eager targets |
| Out   | `reply { requestId, ok, result \| error }`     | Settles a call                                                                                       |
| Out   | `state { target, version, snapshot \| patch }` | A target's state: full, or only the sections whose revision changed                                             |
| Out   | `event { target, name, data, at? }`            | Something happened (transient, not state); `at` is the occurrence time, strictly increasing within the same target, used to identify replays                |
| Out   | `error { message }`                            | A frame that is completely unreadable                                                                                     |

Rules:

- Frames on the same connection are processed **strictly in arrival order** (a `prompt` before an `abort` will not be reversed).
- A bad frame only gets an `error` reply; the connection is not closed.
- State carries a **revision** per **section**; unchanged sections are not sent. For product targets, the revision is a hash of the section content (`publish` in `wire.ts`); the writer only needs to say "this target changed" (`wire.pushNow`), and the wire computes what actually changed.
- There is a **frame-rate budget**: a push is only a "mark"; what is actually sent is the latest state at that moment. Large frames buy longer silence, so streaming output cannot flood a tab; the final state is always delivered.
- Each target has an **event replay ring** (512 entries): late subscribers catch up on recent events after the snapshot. After a restart the ring is empty.
- **Missing target**: when subscribing to an unregistered name (a nonexistent `tasks.<id>`, `routines.<id>`, or `sessions.<id>`), or a target is taken away while it is being subscribed to (the task was deleted), the server returns one event frame `target:missing` (`data: null`, no `at`, not added to the replay ring, sent only to that subscriber). It is an answer to the subscription, not something that happened; if the name is later registered and state arrives, it replaces it. The Web stores it as `store.missing[target]` and clears it when state arrives, the last user leaves, or the connection is re-established; the "not found" on the task page and routine page is determined by it, no longer inferred from the list.
- After a disconnect and reconnect, the new connection starts from scratch: the browser resubscribes to every target still in use, and the host returns a full snapshot; calls that never receive a reply fail with "unknown result" and are not replayed.

## target and action

Names are flat `target.action`. `hello.ops` gives the schema and description of each op; the types live in `packages/client-contracts` and are shared by the Web and host.

Upstream provides (bundled plugins):

| target                      | Content                                                                                                                          |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `sessions`, `sessions.<id>` | Session list; view of a session (prompt segments, tools, usage, goal, model and thinking profile, pending questions) and actions like `prompt`, `abort`, `answer` |
| `providers`                 | Model services and credentials, including Codex device code login and model discovery                                        |
| `settings`, `personas`      | Global settings; persona cards                                                                                               |

Product plugins (`apps/eta`, all are cordis plugins, injecting `wire` and `sessions`):

| Plugin        | target                                | action                                                                                                               |
| ------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| agents        | `agents`（eager）                     | `create` `update` `delete` `direct`                                                                                  |
| machines      | `machines`（eager）                   | `enroll` `approve` `revoke` `rename` `setMaxActiveRuns`                                                              |
| projects      | `projects` (eager)                    | `create` `update` `setSteward` `files` (archive via `update`)                                                        |
| conversations | `conversations`、`conversations.<id>` | `create` `update` `invite` `remove` `setSteward` `send` `stop` `read` `history` `attach` `unattach`                  |
| inbox         | `inbox`                               | `answer` `setApprovals`                                                                                              |
| email         | `email`、`email.<thread-id>`          | `saveAccount` `removeAccount` `verifyAccount` `refresh` `markRead` `assign` `confirmProposal` `discardProposal`      |
| usage         | `usage`                               | Read-only                                                                                                            |
| tasks         | `tasks`, `tasks.<id>`                 | `update` `comment` `delete` `link` `confirmDraft` `interrupt` `rerun` (no `create`, see [Tasks](tasks.md))           |
| artifacts     | `artifacts`                           | `share` `unshare` `delete` `preview`                                                                                 |
| routines      | `routines`、`routines.<id>`           | `create` `update` `delete` `run` `seen` `feedback` `restoreBrief`                                                    |
| mcp           | `mcp`                                 | `connect` `reconnect` `login` `completeLogin` `logout`, see [MCP](mcp.md)                                            |
| plugins       | `list` `audit`                        | `configure` `setLevel` `add` `update` `remove` `recheck`, see [Plugins](plugins.md)                                  |
| github        | `github` (mounted only on load, not loaded by default)  | `refresh` `createApp` `setOAuthClient` `authorize` `unauthorize` `disconnect` `pull` `merge`, see [GitHub](github.md) |
| memory        | `memory` (mounted only when sidecar is present)            | `list` `remember` `forget`                                                                                           |
| llm           | `llm` (eager; mounted only when gateway library is present)      | `refresh` `loginStart` `loginPoll` `loginSubmit` `loginCancel` `setEnabled` `remove`                                 |

Eager targets arrive with `hello`, so the page can render without subscribing first.

## How to upload attachments

Attachments use the same WebSocket, without opening a separate HTTP route: `conversations.attach` sends one chunk at a time (up to 384 KiB of base64 file content), `index` strictly increments from 0, `last` marks the final chunk, and the reply includes the attachment on the last chunk. The upload ID (`uploadId`, a client-generated UUID) is the attachment ID, so resending the same chunk after a lost reply is part of the same upload. Chosen over HTTP upload: access control, reconnection, and timeouts are already handled on this connection, and the UI doesn't need to recognize a second authentication; the tradeoff is that the 20 MB file limit requires splitting into up to 54 calls, which is sufficient for manually pasted files. The `attachments` in `conversations.send` lists uploaded attachment IDs (up to 10, text can be empty); once the message claims them, they can no longer be unattached (`unattach` only unattaches unsent ones).

## Images in sessions

The `transcript` segments of `sessions.<id>` only include the last 200 lines of messages; earlier ones are paged back via `sessions.history` using `beforeSeq`. Neither includes the images themselves: image blocks in user messages and tool results (e.g., `Read`ing a screenshot) are replaced with `{ type: "image", mimeType, data: "", bytes }`, where `bytes` is the decoded byte count. Images remain fully intact in the logs; when the UI needs to render them, it uses `sessions.image` (`session`, `entryId`, `index` indicate the position of the image block in that message's `content`) to fetch `{ mimeType, data }`; it errors if that position is not an image. This is because every snapshot resends the entire window, and base64 for a dozen screenshots can make a single frame several MB. Sessions on the daemon are the same: the view on the daemon already strips images, and `sessions.image`, like other `sessions.*`, is forwarded by `RemoteSessionsRouter`.

## How the UI uses it

`apps/web/src/lib/wire.ts` is the page's only connection: handling hello, reply, state, event, and reconnection with increasing intervals; `queries/wire.ts` wraps it into React hooks (`useTarget`, mutations for calls). Plugins not present in `hello.mounted` have their corresponding entries hidden (e.g., no memory page if the memory sidecar isn't configured). During development, vite proxies `/ws` to the host; in production, the page is same-origin with the host.

## HTTP not exposed online

Outside of `staticRoutes`, only these exist: `/up` (health), `/version` (build ID, used by the page to prompt "new version available"), static pages (falls back to `index.html` when the path is not a file), artifact's `/preview/…`, `/share/…`, `/artifacts/<id>/<version>/archive.zip`, MCP login callback `/mcp/oauth/callback`, GitHub's two callbacks back to the host `/github/manifest/callback`, `/github/authorization/callback` (see [GitHub](github.md)), and the daemon's two endpoints `/machines/enroll`, `/machines/connect`. No REST, no OpenAPI.
