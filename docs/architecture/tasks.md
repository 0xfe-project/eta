# Tasks

A task is an item on the board and also **a piece of work that can be executed**: by default it is executed by the agent that proposed it; if the draft specifies `assignee_agent`, that Agent executes it. The executor works in one of its own sessions and hands it back for acceptance when done. Later comments on the task wake it up again, **continuing in the same session** (see [Run](#run)). The code is in `apps/eta/src/tasks`, and the contract is in `packages/client-contracts/src/tasks.ts`.

## Who creates a task and who executes it

- **Users cannot create tasks.** There is no `tasks.create` online, and the UI has no "New". Tasks only come from agent tools: `draft_task` (proposal, confirmed by the user) and `create_task` (created directly when the user explicitly asks).
- **Tasks are created by agents, and the executor is determined by `assignee_agent`; without `assignee_agent`, it falls back to the creator** (`assignee_agent ?? created_by_agent`). A normal task can be handed off by its creator to another Agent for execution; earlier user-created tasks have no executor and are notes on the board that cannot run.
- **Captain's "assignment" is not the task assignee above**: Captain only posts a visible work authorization in the group chat, and the target Agent calls `create_task` itself; therefore that Agent is both creator and executor, and does not need to—and cannot—use `assignee_agent` to hand the task to someone else.
- A task has a number (`#12`, `AUTOINCREMENT`; deleting the latest does not reuse it), title, description, status `backlog | todo | in_progress | in_review | done | blocked | cancelled`, project, workspace, and origin conversation (`origin_conversation_id`, always the one that proposed it; execution results are sent back there; `conversation_id` is the currently associated conversation and can be changed).
- **One entry point**: online actions and agent tools are the same set of operations (`TaskBoard`). Validation, changes, and the activity record they leave are a single write; all of the task's cards refresh in that same write, and only then is the viewer notified.

## Drafts, confirmation, and cards

The agent calls `draft_task` in a conversation: title, goal, decisions made, acceptance criteria, origin, plus the choice of **workspace**. This is a row in the conversation timeline (`task_draft`); there is nothing on the board yet. The user can change the title, description, and initial status and then confirm (`tasks.confirmDraft`); the same row becomes the task's card (`task_card`), and the task is enqueued (if the initial status is `backlog`, it is only created and not run). The draft's description must be written for "a reader who knows nothing": the executor cannot see this conversation.

### A draft belongs to the turn that wrote it

`task_draft`'s `data` carries `turnMessageId`: the id of the reply row that wrote it. The host already has to find this row (to compute the origin's "items N–M"), so it records its id along the way—**attribution relies on data, not on guessing order**; two drafts in one turn, or two turns interleaved, will not be misaligned. On confirmation the same row becomes `task_card`, and this field is carried over; the card therefore stays in the turn that proposed it and refreshes with the task. `MessageView.data` is JSON, with no migration; old rows missing this field are rendered independently as-is on the timeline.

The page draws rows with this field inside that reply's frame (`Turn` → `.turn-tasks` in `chat-panel.tsx`): same author, same footer time, with indentation and a hairline indicating which turn it comes from. It does **not** go into the collapsed execution process (`ProcessBox`): a draft asks the user for a decision, not a step the agent took; once the turn settles, it is at the same level as the answer.

Collapsing uses the repository's existing syntax (native `<details>` + `.thinking-block-header` + chevron), and defaults match `ProcessBox`: expanded while the turn is in flight, collapsed to one line once settled. The reader's own open/closed choice is recorded per message id in localStorage (`lib/fold.ts`), is not overridden by the default, and is unaffected by refresh. The collapsed title row carries "Pending confirmation" and the confirmation entry point: what is hidden when collapsed is its body, not its question.

**Drafts do not count toward attention; this is explicitly unchanged this time.** Attention counts the things waiting for you elsewhere—questions, blocked / in_review tasks on the board, unseen routine reports—they all hide somewhere "you won't know unless you look there", so they get their own row. Drafts already have two outlets: a draft is an agent row on this conversation's timeline, and the conversation list's unread count increments by one for it (`digest` in `timeline.ts`); and the card itself carries a marker and confirmation entry point, even when collapsed. It has no "seen" or "dismissed" state—until confirmed it stays there, and counting it toward attention would be a badge that can only be removed by confirming or deleting the row. After confirmation it is a task on the board, and then it enters attention according to the task's own status (blocked / in_review).

## Workspace

Chosen by the agent when creating a task (`workspace`):

| Mode       | Meaning                                                                                                                                                                      |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `worktree` | Default for git projects. Creates a git worktree for the task on the machine where the project lives, branch `eta/task-<number>`, starting from the project's current commit |
| `local`    | Work directly in the project directory. Projects that are not git repositories can only use this                                                                             |

Checked at proposal time: requesting `worktree` for a project that is not a repository is rejected by the tool, so the agent hears about it on the spot rather than waiting for a run to fail.

**The worktree location** is a stable path under that machine's own eta data directory, not inside the project directory:

- primary: `<data directory>/worktrees/<project id>/task-<number>`
- daemon machine: `~/.eta/worktrees/<project id>/task-<number>` (the daemon runs as the same user that reads and writes files for sessions)

It is placed outside the project directory to keep the project's `git status` clean; the path is determined only by the task, so a rerun returns to the same files; nothing deletes it, because it holds work that is being accepted. If the branch already exists (created by a previous run), it is reused directly. Creating a worktree is a shell snippet executed through the machine's transport: primary in its own shell, daemon over the link, with identical text (`workspace.ts`). The worktree path and branch are written back to the task after the first run creates them, and are shown on the task page.

## Run

A run is one attempt by the executor at a task (`task_run`, status `queued | starting | running | completed | failed | interrupted`); **the table itself is the queue** (`runner.ts`).

- **The session belongs to the task.** `openRunSession` uses `existing` to decide whether to reuse the task's existing session or open a new one: the task's first run (and `tasks.rerun`) opens a new one, while a run woken by a comment continues in the task's session. The session has this agent's model, persona, instructions, skills, MCP servers, and memory hooks, exactly like its session in a conversation (going through the same `place.ensure`), but no conversation history and no participant rows. The session lives on the machine where the project is, with cwd set to the workspace. **It does not appear in the sidebar** (the sidebar is conversations); it appears only on the task page: status plus execution record.
- **The session key.** A conversation session uses the conversation id as `SessionMeta.conversationId`; a task session uses `task:<task id>` (`session-key.ts`). Sessions outlive a run, so the key must identify whose it is; the task is that unit. A session keeps the key it was created with (the run that created it records the key in `task_run.session_key`, and later runs reuse it), so old sessions whose key is still `task-run:<run id>` are also recognized and can be reopened. Tools, the daemon's ownership checks, usage, questions, and memory all recognize this key: usage and questions are attributed to the origin conversation, and memory hooks are fetched by origin conversation. When a tool wants to know "which run is reading/writing me now", it asks on the spot (`runner.workingRunOf`), not fixed at session creation time. Sessions have no conversation tools (`mention`, etc.), but have `list_tasks`, `get_task`, `update_task`, `comment_task`, and `finish_task`.
- **The first prompt** is the task itself: title, description (goal, decisions made, acceptance criteria), the name and id of the source conversation, where the work is, how to report, and not to merge into the main branch when the task doesn't say so. A run woken by a comment doesn't hear the briefing again: it already has what it did above it, so just tell it where the task stands now and that what it needs to say is below.
- **Queue.** Runs are queued by `created_at`. Starting needs two conditions: this task's previous run has finished, and the machine has a free slot. Otherwise mark the reason: `task_busy`, `machine_full`, `machine_offline`. `pump()` is called at every moment that could change the answer (something new queued, a run finished, a machine came online, a limit was changed).
- **The per-machine concurrency limit** is a machine setting (`machine.max_active_runs`, default **2**, 1–20, changed in Settings → Machines, `machines.setMaxActiveRuns`).
- **The run log is the session's transcript.** The task page subscribes to `sessions.<session id>` and renders it live with the same blocks used in chat (thinking, text, tool cards); there is no second record. The first user message (the briefing) is not shown. Tool cards are drawn by the input shape of the call (`apps/web/src/lib/tool-shape.ts`): edits are diffs, commands are a terminal plus exit code, todos are a list, images in results are thumbnails that open full-window when clicked (the image itself is fetched on demand via `sessions.image`); external runtime exit codes, sub-agent steps and runtime tasks live in `toolResult.details` (written by `eta-runtime-oar`'s translator); when an external runtime calls eta's own tools over MCP, the transcript shows the tool's own name and the `details` it left (`host-calls.ts`), same as the built-in kernel. Errored turns and context compaction each get their own line. The view carries only the most recent 200 entries; scroll to the top and page back with `sessions.history`. The dialog has fixed dimensions (`min(960px, 100vw − 4rem)` × `min(800px, 100dvh − 4rem)`, fullscreen on narrow screens), and it is the same `TranscriptDialog` as "View all" in the group chat process box.
- **It ends via `finish_task`.** The executor calls it: the summary becomes a comment on the task, the task moves to `in_review` (or `blocked`: needs the user), and **as the agent** it posts "#number title + summary" to the source conversation. The worktree is kept; merging / opening a PR or discarding is decided after acceptance, not automatically. A run that goes quiet without calling it is reminded once, and fails if it still doesn't report.
- **Comments always get read.** While a run is active on the task, a user's (or another agent's) comment is delivered into its session as a user message: steered mid-turn if a turn is in progress, otherwise it waits for the next turn. When no run is active, a comment is a prompt: it queues a **continuation run** (`task_run.continues_run_id` points at the run it continues, and the task page's execution record says so too), queued into the task's session to carry on — the executor already has what it did above it, so it needn't read the project again. Queueing follows the same rules as the first run (`machine_offline`/`machine_full`/`task_busy`), and the comment waits along with it. No asking the user, no dialogs.
  - `blocked`: the executor said "I need you" via `finish_task(blocked)`, so the user's comment is the answer — this is the rule's main use.
  - `in_review`: a comment means "acceptance failed / change it a bit more", so it continues.
  - `done`, `cancelled`: that is a closing remark (moving to these states stops the run anyway), so nothing is woken; the comment is still recorded on the timeline.
  - `backlog`: the task hasn't been claimed yet, so the comment is only recorded.
  - The executor's own comments are not fed back to it and don't wake it. A retry with the same `clientId` is still the same comment: delivered once, woken once.
  - The cost: the same session keeps growing and is reined in by `packages/eta-compaction` — that's the price of "it remembers", not a defect. An interrupt counts as a full stop: no continuation run is owed, and the words stay on the task's timeline. A host restart drops the few lines waiting in memory (the queued continuation run itself is in the table); such a run is told to go read the timeline itself.
- **Interrupt and rerun.** `tasks.interrupt` stops a run (a queued one never starts, a running one ends as `interrupted`, the task status is untouched); moving a task to `done`/`cancelled` also stops its run. `tasks.rerun` starts a new run, **discarding memory and beginning from scratch**: a new session that doesn't remember what the last one did. To continue with memory, write a comment. A task can only have one unfinished run at a time.
- **Restart.** On restart, leftover `starting/running` runs are all marked failed ("the server restarted"), and queued ones keep waiting. If the link drops mid-run, the run fails as "result unknown" and is not replayed.

## Runs on a daemon

When the project is on another machine, the run's session lives on that machine: journal, kernel and tools are all in the daemon, while model calls and product tools (tasks, artifacts, memory) come back to the primary over the link (see [Machines and daemons](machines.md)). The primary trusts its own `task_run` row for which run a session belongs to (when a session is shared by several runs, the running one counts), and requires that the machine owning the link is the machine recorded for the run. While a machine is offline, runs queue (`machine_offline`) and start once it connects.

## Actions on the wire

| action                | Meaning                                                                  |
| --------------------- | ------------------------------------------------------------------------ |
| `confirmDraft`        | Confirm draft, create task and enqueue                                   |
| `update`              | Change title, description, status (drag between columns too)             |
| `comment`             | Comment; deliver into the running run, or wake a continuation run        |
| `interrupt` / `rerun` | Stop a run / start a new run                                             |
| `link` / `delete`     | Link a conversation / delete a task (can't delete while a run is active) |

`tasks` is one eager list (each row carries `runStatus`); each task is `tasks.<id>`: `task` (details, including the workspace and `runs`) and `activity` (the timeline, containing `run_queued/started/completed/failed/interrupted/nudged`).

## Agent tools

The agent in a conversation: `draft_task`, `list_tasks`, `get_task`, `create_task`, `update_task`, `comment_task`. The executor in a run: `list_tasks`, `get_task`, `update_task` (can't move directly to `done`/`cancelled`/`in_review`), `comment_task` (acts on its own task), `finish_task`. The tool descriptions carry the discipline: `draft_task`'s description opens with self-checkable triggers (editing files in the repo, running a build or tests, results that need human acceptance, anything you know will take several rounds of tools) — hit any one and don't do it in chat; what stays in chat is reading, looking things up, explaining, Q&A, taking a position, and verifying with one or two commands. `mention` hands the words to a human; `draft_task` takes the work out of this turn: it is a proposal on the board that becomes a task once the user confirms it, executed by `assignee_agent` (the agent that proposed it when none is specified) in a new session that cannot see this conversation.
