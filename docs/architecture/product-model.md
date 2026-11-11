# Product model

| Concept         | Meaning                                                                                                                                                    | Table                                    | target                                |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------- |
| Agent (persona) | Global config: name, instructions, persona card, model and thinking level. **Not a container**, it owns no sessions or conversations                       | `agent`                                  | `agents`                              |
| machine         | Which computer the session runs on: the primary where host lives, plus the other machines running daemons                                                  | `machine`                                | `machines`                            |
| project         | A directory on one machine, with a steward                                                                                                                 | `project`                                | `projects`                            |
| Conversation    | A timeline belonging to one project, whose members are several agents                                                                                      | `conversation`, `participant`, `message` | `conversations`, `conversations.<id>` |
| session         | A session of the upstream harness, one per (agent × conversation), with cwd set to the project's directory and running on the machine the project lives on | Upstream files (see [data](data.md))     | `sessions.<id>`                       |

## Agents

- Fields: `name`, `instructions` (appended after the base of every session's system prompt for this agent), `persona` (the name of a persona card; an empty string is the project's default card, which differs from "no persona"), `model` (`provider:modelId`, empty means follow settings), `thinking_level`.
- On creation it gets its own workspace on the primary node, `<data directory>/agents/<id>/`, which is also a project of kind `agent_home` whose steward is itself, and both appear together in one transaction. Renaming moves the directory.
- A **DM** is the `direct` conversation in its workspace whose only member is itself (`agents.direct` gets or restores it).
- Deleting an agent first stops the reply it is writing; the lines it wrote on the timeline are kept.

## Projects and stewards

project = machine + directory (unique per path on the same machine). `steward_id` is the steward: messages that don't @ anyone go to it. A conversation can have its own steward (`conversation.steward_id`); when empty, the project's is used. Effective steward = the conversation's ?? the project's (`effectiveSteward`).

**File list** (`projects.files`, used by the composer's `@` menu): listed by a shell script on the machine the project lives on (the local machine via the process's own shell, a daemon via the link's `exec`, so there is only one implementation): in a git checkout it takes the files git knows about (tracked, not ignored), otherwise a `find` with depth ≤ 8; then filters out `node_modules`, `.git`, `.eta`, `dist`, `build` and similar directories, sorts shallow-first, defaults to 2000 and at most 5000 entries, with `truncated` when it overflows. Paths are relative to the project directory, i.e. the agent's working directory. In the menu, members come first and files after.

**List directories** (`projects.directories`, used by the directory picker): likewise a shell script on the target machine, listing only directories (including symlinks to directories), with `hidden`, `git` and the existing `projectId`, without touching file names. It does not use `ExecutionEnv.listDir`: that stats each entry one by one, and directories unreadable from the remote side end up as empty. Paths are normalized as text, without resolving symlinks, matching the key stored by `projects.create`. At most 1000 entries, with `truncated` when it overflows and visible directories first. On failure `problem.code` is `not_found`, `denied` or `offline`, with no system details.

**Switching stewards**: the old agent's session is kept and it can still be @-mentioned; the new agent's session is created only on its first wake-up, and it is told only the parts it hasn't seen (the lines after `participant.last_seq`); a `system` line lands on the timeline ("X is now the steward, taking over from Y").

## Conversations and members

- A conversation's `kind` is `group` or `direct`. It has two text blocks, `goal` and `decided` (the discussion's goal and the conclusions reached), plus `read_seq` (how far the user has read) and `archived`.
- `participant`: who takes part. `session_id` is that agent's session in this conversation (created on first wake-up, reused ever after, and found again from this row after a restart); `last_seq` is the line it has been told up to.
- `message` (the timeline): `seq` increases within a conversation and is the reading order. `kind` is one of `message`, `mention`, `system`, `task_draft`, `task_card`; `status` is one of `queued`, `working`, `waiting_for_input`, `done`, `failed`, `stopping`, `stopped`. **A reply row holds its place**: it has a `seq` as soon as it is queued, and as text arrives `revision` grows while `seq` stays the same.
- When a reply finishes, the run's tool activity is stored in the row's `data.activity` (`ToolActivity[]`: name, truncated input, at most the first 2000 characters of output, status, and the `details` the tool left for the page, such as the artifact reference from `publish_artifact`; `details` over 4000 bytes are dropped, at most 200 entries). While a reply is in progress the page draws tool cards from the session's transcript; afterwards it draws the same cards and artifact cards from here. For remote sessions the daemon's `run` brings them back in `RunOutcome.activity`, so no migration is needed.

## Attachments

A user row's `data.attachments` (`AttachmentView[]`: id, name, type, size) lists the files it brings; the files themselves live in the primary node's data directory (see [data](data.md)), and how they are uploaded is in [wire protocol](wire-protocol.md). When an agent is woken (or joined by an interjection), the briefing lists each message's files underneath it: a **local session** gets absolute paths to the files in the data directory; a **session on a daemon** gets copies written on the daemon machine at `~/.eta/uploads/<conversation id>/<attachment id>-<name>` (written in chunks via the link's `exec`, skipping files that already exist at the same size). If a file can't be written, the briefing says why and the reply runs as usual. png/jpeg/gif/webp images (at most 4, 3 MB total) are also sent to the model as images with this message when the session's model declares image input support; when it doesn't, only the paths are given and the agent can read them with tools.

## Wake-up rules

**One wake-up is one reply row.** There is no separate wake-up table or queue: a `queued` reply row is a wake-up waiting for its session, `working` is one in flight, and on process restart any leftover in-flight rows are all marked failed ("the service restarted and this reply did not finish").

Who gets woken (`conversations/routing.ts`, pure rules):

1. Members @-mentioned in the user message (only members count).
2. No @ and it's a DM: the one and only agent.
3. No @ and there is an effective steward: the steward (joined first if not yet a member).
4. No steward and only one member: that member.
5. Everything else: nobody is woken, and the sender is told — no guessing.

Agents hand work to each other with the `mention` tool (by name or id; an unknown name is reported back to the agent): the named agent is woken, the initiator does not wait. **Five-wake budget**: agent-to-agent mentions triggered by one user message total at most 5 across all branches (`WAKE_BUDGET`); the 5th still wakes and carries a reminder, after that it is only context, until the user speaks again and the count resets.

**Serial within a session, parallel across sessions**: a session answers one thing at a time; an agent in three conversations has three sessions, and three members' conversations can run three at once. The queue key is the participant (it exists before the session is created). Sending has two modes: `queue` and `steer` (merge into the round currently answering); a retry with the same `clientId` is the same message.

**What a woken agent sees** (`briefing.ts`): its own session has only ever heard what was said to it, so each wake carries every line after `last_seq` (who said it + content, at most 100 lines, each truncated to 2000 characters), plus the line that triggered it. Lines not yet finished don't count as seen, and the watermark won't pass them.

Tools in a conversation (registered on each (agent × conversation) session): `mention`, plus `conversation_info` (to see the current conversation's goal and members); other features add their own (tasks, artifacts, memory, routines).

## Inbox and approvals

Questions (ask) in a session are aggregated by `inbox` into `interaction` rows: posed, answered, cancelled, and expired each have a state. An answer goes back to the asking session via `inbox.answer`, and the round waiting on it continues; the engine hears the same events and switches the reply between `working` and `waiting_for_input`. On process restart, unanswered questions all expire.

**Approval list** (`inbox.setApprovals`, stored in the `setting` table): tools on the list ask the user before running, implemented as tool middleware, the same for local sessions and sessions on the daemon.

## Usage

Every request sent to the model writes one `usage` row (agent, conversation, status ok/error/aborted): turns, each turn retry (the failed one and the later successful one are two rows), compaction summary requests, side questions, memory extraction, and subagent turns (recorded under the agent and conversation that dispatched them). The accounting point is the model layer (`generated` in `assembleServer`), not the session's turn events; remote session requests are recorded in `model.stream` on the main node, kept for 30 days, pruned at startup and once a day after that; every total the UI shows is a read of this table, there are no counters.
