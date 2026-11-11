# Tasks, artifacts, and routines

Three product plugins, all built on conversations and sessions: tasks are a board, artifacts are static pages published by agents, and routines are short sessions that run on a schedule.

## Tasks

Board (`tasks` / `tasks.<id>`, `apps/eta/src/tasks`): an agent proposes a task, the user confirms it, the proposing agent executes it in its own session and hands it back for acceptance when done; a comment on the task wakes it once more in the same session. The full description (drafts and cards, workspace, run queue, `finish_task`, runs on the daemon) is in [Tasks](tasks.md).

- **Delivered PRs**: the task board doesn't know GitHub; after an agent runs `open_pull_request`, the GitHub plugin records the PR in its own `task_pull` table, and the “Delivered” line on the task page reads it, shows the PR's current status, and can merge it. Which task a PR belongs to: the task's session (session key `task:<task id>`) belongs to that task; a conversation's session belongs to the most recently touched, unfinished task in that conversation (`todo`, `in_progress`, `in_review`, `blocked`). See [GitHub](github.md).

## Artifacts

An agent publishes a static site with `publish_artifact` (a directory with an `index.html` at its root, may contain CSS, scripts, images); users can preview, share, and download it. With `spa: true` it is a single-page app: navigating to a path with no file returns `index.html`, while missing `.js`, `.css`, and images are still 404.

- **A site is validated before it is stored** (`files.ts`, `kinds/site.ts`): there must be an `index.html` at the root, paths must be clean relative paths, symlinks are not allowed (`.git` and `node_modules` are skipped), and file count and total bytes have limits (default 5000 files, 100 MiB). If it fails, the whole thing is rejected with a note on what to fix — half a site that looks like it works is worse than none.
- Files are read through **the session's own execution environment**, so a session on another machine publishes the directory on that machine.
- **Versions**: publishing again with an `artifactId` makes a new version of the same artifact, not a new artifact. Each version is a ZIP plus the unpacked site, under `<data directory>/artifacts/<artifact>/<version>/`; files are written first and the row second, so a row always means the files exist, and a directory with no row is debris left by a crash, replaced the next time the same number is published. A version can be linked to a task (listed on the card).
- **Preview** uses a signed URL valid for one hour; **share** is a public token bound to a specific version, at most one share per version at a time, and revoking it invalidates it permanently. See [Access control](access.md).
- **Kinds**: each version has a `kind` and a `manifest` (JSON), fixed after publishing. The kinds in `apps/eta/src/artifacts/kinds/` decide how to validate (`prepare`), where to open (`entry`), how to answer a request (`respond`), and how the frontend opens it (`viewer`); currently only `site`. Authorization, path and size limits, and sandbox response headers live in the core, and kinds and manifests cannot loosen them. A kind the host machine doesn't recognize is offered only as a ZIP.
- target: `artifacts` (list), actions `share`, `unshare`, `delete`, `preview`.

## Routines

An agent-like thing runs on a schedule and leaves a report, but **there is no agent behind it** — only a model, a brief, and a clock. target `routines` / `routines.<id>`.

- **Clock** (`scheduler.ts`): an in-process timer, no message broker. A schedule stores a shape: `daily`, `weekly`, `hourly` (every 1/2/3/4/6/8/12 hours), `cron` (five fields), with the time zone stored separately; the next run is computed from the schedule and time zone and **not persisted** (`croner` does the math). A routine that is created, paused, resumed, or rescheduled is automatically rescheduled from "now", with no one needing to notify the clock that something changed. **Missed times are not made up**: a time that passed while the process was down counts from "now" after restart, it won't backfill three runs at once; a brief sleep and quick wake counts as one run; a routine already running is skipped this time.
- **Runs** (`runner.ts`): a run is a short-lived upstream session whose working directory is `<data directory>/routines/<id>/`. The rules: a run either **reports or says nothing** (decided by `finish`; without a `finish` call the last message becomes the report; saying nothing is a failure); at most 15 minutes, timing out counts as a failure; **at most one run per task at a time**, guaranteed by a unique index on the table; leftover `running` rows are all marked failed on restart. A run ends as `sent` (has a report), `no_news` (looked, nothing new), or `failed`.
- Tools inside a run: `list_runs`, `get_run`, `search_runs` (only the history of its own routine), and `finish`. The first message of each run carries everything it could not look up itself: who it is, what time it is, what to do, what handoff the previous run left, and how to end.
- **Briefs are versioned**: every change is a new version, not an edit, because old versions are what earlier runs followed; "why did it do that" is answered by the version that introduced the line, and restoring old text writes it as the newest version (`restoreBrief`).
- **Feedback revises the brief**: user feedback on a report (`routines.feedback`) revises the brief in the background, one round per routine at a time; the revision reads the brief it is about to replace, and if the brief changed in the meantime it starts over from the new text. One piece of feedback produces at most one brief version (unique index). Revisions left unfinished by a process restart continue when the runner mounts.
- A report can be sent as a `system` line into a conversation (`routine.conversation_id`; skip if empty).
