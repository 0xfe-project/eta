---
name: axp
description: Working on a task from AXP's task board on this computer with the axp CLI. Use when you were handed an AXP task: to read it, reply on it, set its status, publish a static page as an artifact, or open a pull request or add attachments as AXP's GitHub App.
---

# AXP tasks

AXP hands you a task to work on here and sends each new comment on it as a
follow-up. Talk to the board with `axp` (`axp help` lists its commands; if it
is not on PATH, the prompt names its full path). Run it in the task's working
directory or below it, which is how it knows the task; elsewhere, add
`--task N` to an `axp task …` command (`axp task show --task 12`).

- `axp task show`: the task, its status and its timeline (comments, status
  changes, deliverables). Read it when a follow-up needs context.
- `axp task comment "<Markdown>"` (or `--file <path>`): reply on the task.
  End every turn with one saying what you did, how it went and what you
  still need; AXP reminds you once when a turn ends without one, then fails
  the run.
- `axp task status in_review|blocked|in_progress`: `in_review` when your
  work is ready to be checked, `blocked` when you need a person. Marking the
  task done is the user's call.

- `axp task assist <runtime>/<provider> "<request>"` (or `--file`): ask
  another agent on this computer to assist with the task, e.g.
  `axp task assist paseo/codex "审查 PR" --after current --rounds 3` to have
  Codex review your pull request once your current run has delivered, and
  send you its changes until it passes (at most 3 reviews). `--after`
  waits for a run of the task's assignee; when the task has a pull request
  the agent is given it, pinned at its head. `axp task show` lists the
  requests and loops.

When the prompt says you are assisting (请 Agent 协助), the task belongs to
another agent: do only what was asked, in the worktree AXP opened for you,
and reply with `axp task comment`. Status changes are refused to you. A
review ends with its verdict instead: `axp task review pass`, or
`axp task review changes --file <feedback>` with what to change (files,
lines, how); in a review loop the changes go to the assignee and its next
push comes back to you. A verdict is given once.

## Artifacts

When a result is best seen as a page (a report, a chart, a prototype),
publish it on the task:
`axp artifact upload <dir|zip> --title "<title>"`. The directory (or the
ZIP's root) holds `index.html` with its CSS, JS and images, linked by
relative paths. The user opens it from the task's timeline and may share it
publicly, so never put secrets in it. Each upload is a new version; pass
`--artifact <id>` (printed by the first upload) to update that artifact
instead of making another. It runs sandboxed: no cookies, storage or AXP
API; public CDNs work, bundled files are more reliable. Limits: 90 MiB
zipped, 5000 files.

## GitHub

`axp gh <args…>` runs gh through AXP's GitHub App, in the user's name when
they have authorized the App (it says so first), else as the App's bot.
In the user's name it can do what both the user and the App can, including
creating a repository in their account (`axp gh repo create`); the bot
cannot create one in a personal account. Open pull requests with
`axp gh pr create …` after pushing the branch: AXP records the pull request
as the task's deliverable. Your git push uses this computer's own
credentials.

### Attachments

If attachments are needed, create the PR first, then try this computer's own
gh login with `--attach`, for example:

```sh
gh pr edit <PR-URL> --attach './before.png#Before' --attach './after.png#After'
```

Run it where the image files are, keep the PR's current body, and use plain
`gh` rather than `axp gh`. If the CLI, `--attach` or the login is
unavailable, say so in your comment and keep the PR. Check the PR after an
upload attempt before retrying, since a failure can still leave some
attachments uploaded.
