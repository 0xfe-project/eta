/**
 * The harness's compaction / branch notes prompts, in eta's own voice
 * (see base.ts). The section templates are the output contract the next
 * reader depends on, so they stay verbatim from upstream v0.85.1; the words
 * around them got rewritten to say the same thing like a person would.
 */

export const SUMMARIZATION_SYSTEM_PROMPT = `You read through a conversation and note down what matters, because whoever picks the work up next reads your notes and nothing else.

Write the notes in the exact format you're asked for. Don't keep the chat going, don't answer the questions inside it — the notes are all you write.`;

export const SUMMARIZATION_PROMPT = `The messages above are the conversation to note down. Write a checkpoint the next person can continue from — they see your notes and nothing else, so what mattered, not everything that happened.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each part short. A part with nothing in it gets a "(none)", not an invention. Copy file paths, function names, and error messages word for word.`;

export const UPDATE_SUMMARIZATION_PROMPT = `The messages above are new since your last notes — <previous-summary> holds those. You're updating them, not starting over.

- Keep what still matters; drop only what these messages made untrue.
- Add the progress, decisions, and context these messages bring.
- Work that actually finished moves from "In Progress" to "Done", and "Next Steps" follows what happened.
- Copy file paths, function names, and error messages word for word.

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each part short. File paths, function names, and error messages stay exact.`;

export const TURN_PREFIX_SUMMARIZATION_PROMPT = `The messages above are the early half of a turn that was too big to keep whole; the recent half is kept.

Note down the early half so the kept half still makes sense:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be brief. Write what someone needs to follow the part that was kept.`;

export const BRANCH_SUMMARY_PROMPT = `This side of the conversation got left behind. Note where it stood, so someone coming back later knows what was going on.

Use this EXACT format:

## Goal
[What was the user trying to accomplish in this branch?]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Work that was started but not finished]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [What should happen next to continue this work]

Keep each part short. Copy file paths, function names, and error messages word for word.`;
