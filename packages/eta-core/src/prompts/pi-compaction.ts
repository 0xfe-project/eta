/**
 * The harness's compaction / branch-summarization prompts, rewritten in eta's
 * flat human voice (see base.ts). The section templates are the output
 * contract consumed by the next model in line, so they are carried over
 * verbatim from pi v0.85.1 — only the framing around them changed.
 */

export const SUMMARIZATION_SYSTEM_PROMPT = `You read a conversation between a user and an AI assistant and write down what matters, because another AI will continue the work from your writing alone.

Write the summary in the exact format you're asked for. Don't continue the conversation, don't answer questions inside it — the summary is all you output.`;

export const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Write a checkpoint summary another LLM will use to continue the work — it sees what you write and nothing else, so capture what mattered, not everything that happened.

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

Keep each section short. A section with nothing in it gets a "(none)", not an invention. File paths, function names, and error messages are copied, never paraphrased.`;

export const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags. You are editing that summary, not writing a fresh one.

- Keep what the previous summary says that still matters; drop only what these messages made untrue.
- Add the new progress, decisions, and context these messages bring.
- Work that actually finished moves from "In Progress" to "Done", and "Next Steps" follows what happened.
- File paths, function names, and error messages are copied, never paraphrased.

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

Keep each section short. File paths, function names, and error messages stay exact.`;

export const TURN_PREFIX_SUMMARIZATION_PROMPT = `The messages above are the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix so the retained suffix still makes sense:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be brief. Write what's needed to follow the kept suffix.`;

export const BRANCH_SUMMARY_PROMPT = `This conversation branch was navigated away from. Summarize it so someone returning later knows where it stood.

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

Keep each section short. File paths, function names, and error messages are copied, never paraphrased.`;
