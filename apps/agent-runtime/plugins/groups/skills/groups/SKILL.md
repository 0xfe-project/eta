---
name: groups
description: Participate in the current AXP group or direct conversation, retrieve relevant history, ask another agent with mention, and record decisions or draft tasks.
---

# Working in an AXP group

The platform supplies the current group. A direct conversation is also a group. All tools here are scoped to that current group; do not supply or guess another group id. Each group has its own conversation context. Your workspace and long-term memory are shared across your groups. Do not write MEMORY.md or create a working directory per group.

## Read just enough context

You were woken for the message below the group header. Respond to that request. Messages addressed to other agents and messages without a recipient are background, not instructions to start new work.

- On your first visit, call `group_info` to learn the goal, decisions and participants.
- Before answering a request that depends on previous discussion, use `read_group` to read messages since your last participation. Use `before` / `after` sequences to page if needed.
- Use `search_group` with specific terms for earlier decisions, data or links. Stop when you have enough; do not download the entire transcript.
- Do not duplicate another agent's progress report. Only the agent doing the work reports that work.
- Knowledge from another group comes through memory. When citing it, name the source group if available and distinguish it from decisions made here.

## Ask another agent only with `mention`

Writing @Name in ordinary text never wakes anyone. To ask for another agent's expertise, call `mention(agent, message)` once with their exact name or id and a specific, self-contained request. Include the relevant finding, question or task reference; the recipient can read this group's history.

1. Use mention only when the other agent's contribution is needed for the user's request. Do not mention yourself, send acknowledgements, or hand the same question back and forth.
2. A successful result means **the notification is queued**, not that the agent has answered. Continue any independent work and finish your response. Do not wait, sleep, poll read_group for a reply, or repeatedly mention the same agent.
3. The recipient's reply stays in this conversation and **does not wake you back up**. When the user next wakes you, use read_group if you need to see it. If you were mentioned, answer here; do not mention the sender merely to deliver your answer.
4. You may mention a non-member. They participate here for this request only, without becoming a member. The platform shows the user an invitation prompt; do not create a new private conversation or silently invite them.
5. All agents together may send at most **five mention wake-ups originating from one user message**, including parallel branches. The platform enforces this and shows a review reminder here at the limit. On a limit or stop result, stop that exchange, summarize the remaining question for the user, and wait for their next message. Never evade it with another group or a fabricated user message.

Example: the user asks Aria to check a proposal with Bolt. Aria calls mention(Bolt, "Review the concurrency decision above; identify a concrete failure mode.") and reports that Bolt has been asked. Bolt reads the relevant discussion and answers here. Bolt does not call mention(Aria, "Here is my answer"). Aria reads Bolt's answer when the user next addresses Aria.

## Turn discussion into decisions and tasks

Record agreed goals and decisions with `update_brief`. Do not turn proposals into settled decisions without agreement.

Use `draft_task` to present executable work as a draft in this group: a title, goal, decisions, acceptance criteria and a plain-text source (for example, "第 12–18 条"). The source is copied into the task description as a snapshot. The user edits and confirms the draft before a board task exists or an executor runs. Do not call `create_task` unless the user explicitly asks for immediate creation. Group participants discuss and review; task assignees execute through the task system.

For an existing task, show the proposed description changes in the group and get the user’s agreement before calling `update_task`. Preserve its task id and source context; do not create a replacement task just to revise the brief.
