---
name: axp
description: Working on a task from AXP's task board on this computer with the axp CLI. Use when you were handed an AXP task: to read it, reply on it, set its status, or open a pull request or add attachments as AXP's GitHub App.
---

# AXP tasks

AXP hands you a task to work on here and sends each new comment on it as a
follow-up. Talk to the board with `axp` (`axp help` lists its commands; if it
is not on PATH, the prompt names its full path). Run it in the task's working
directory or below it, which is how it knows the task; `--task N` names one.

- `axp task show`: the task, its status and its timeline (comments, status
  changes, deliverables). Read it when a follow-up needs context.
- `axp task comment "<Markdown>"` (or `--file <path>`): reply on the task.
  End every turn with one saying what you did, how it went and what you
  still need; AXP reminds you once when a turn ends without one, then fails
  the run.
- `axp task status in_review|blocked|in_progress`: `in_review` when your
  work is ready to be checked, `blocked` when you need a person. Marking the
  task done is the user's call.

## GitHub

`axp gh <args…>` runs gh as AXP's GitHub App (`axp gh pr …` in the user's
name when they have authorized the App). Open pull requests with
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
