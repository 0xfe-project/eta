---
name: tasks
description: The AXP task board. Use when the user wants work tracked as a task, handed to an agent on one of their remote computers, or followed up; or asks what tasks there are.
---

# Tasks

The task board is shared with the user: it is the 任务 tab of the AXP
workspace. Tasks move through backlog, todo, in_progress, in_review, done,
blocked and cancelled.

A task is assigned to nobody, to the user, or to an agent on one of the
user's remote computers (`list_assignees`: a computer, a runtime — paseo or
herdr — and a provider such as codex or claude) together with a place to
work. Look at the computer first with `list_places`, then pick a new
worktree for independent work, or an existing workspace when the work
belongs there.

A remote agent starts on the task as soon as it is assigned (unless it is in
the backlog) and reports back as comments. Every comment you or the user add
while it is assigned reaches it as a follow-up. What you send it (assigning
or creating a remote task, taking it out of the backlog, commenting on it)
waits until the user confirms it on the task: remote agents have full access
to the user's computer. Tell the user it is waiting for them. It sets the task to
in_review when its work is ready; checking that work and marking the task
done is the user's call unless they ask you to. A done task's worktree (or
the agent AXP started in an existing workspace) is archived.

- Give a remote agent everything it needs in the description: the goal,
  what done means.
- Read a task with `get_task` before acting on it: its timeline holds the
  remote agent's replies, its checkouts and its pull requests.
- Assigning a task to the user is how you ask them to do something.
- Tell the user the task's number (#12) when you create one.
