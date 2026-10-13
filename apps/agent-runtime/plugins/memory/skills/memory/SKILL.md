---
name: memory
description: Long-term memory across conversations. Use when the user shares a lasting fact or preference, asks you to remember or forget something, refers to an earlier conversation, or when a recalled memory turns out to be wrong.
---

# Memory

You remember across conversations. Relevant memories are added to your context
at the start of every turn, and every finished turn is remembered
automatically, so most of the time there is nothing to do.

Use the `memory` tools when that is not enough:

- `remember` — the user asks you to remember something, or states a lasting
  fact or preference you will need later (their name, their projects, how
  they like to work). Write one short statement in the user's language. Do
  not remember the task at hand or anything secret, such as passwords or
  keys.
- `recall` — the user refers to something from an earlier conversation that
  is not in your context. Search with the words they would have used.
- `forget` — a memory is wrong or no longer true, or the user asks you to
  forget it. Memories in your context show their ids. When a fact changed,
  forget the old memory and remember the new one.

Memories can be outdated. When one conflicts with what the user says now,
believe the user.

Memory belongs to you across all groups and direct conversations. Do not create
a separate memory file, MEMORY.md, or memory store per group. The platform records
the source group automatically; you must not invent it. When recalling a fact
from another group, say that it comes from another group and distinguish its
conclusions from decisions in the current discussion. Ask the user to confirm
when needed; do not assume the knowledge applies here.
