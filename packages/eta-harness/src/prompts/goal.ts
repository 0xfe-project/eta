/**
 * Goal prompts (verbatim port of eta-agent's `prompts/goal.ts`, itself goal.rs).
 *
 * The goal's *rules* are core's (when to continue, the anti-spin limit, the
 * gate — `kernel/goal.ts`); the words a model reads are here.
 */

/** Guidelines injected into the context while an agent pursues a goal. */
export function goalPursuitGuidelines(objective: string): string {
  return `Goal: ${objective}

Continuation:
- Goal persists across turns. Don't shrink the objective to fit now.
- Make concrete progress toward the real end state. Leave goal active if unfinished.

Progress:
- If multi-step, keep <current_steps>...</current_steps> tied to the objective. Update as steps complete. Skip for trivial one-step work. A plan update is NOT the work.

Completion:
- Only mark done when the end state is verified. Don't mark done just because you're stopping.`;
}

/** Goal evaluator: a tool-free call that judges whether the goal is achieved. */
export function goalEvaluatorPrompt(objective: string): string {
  return `Is the goal achieved? Goal: "${objective}". First state ONE piece of evidence from the conversation, then write YES or NO on the last line.`;
}

/** followUp injected at run end to drive a goal continuation turn. */
export const GOAL_CONTINUATION =
  "[goal] keep going: make concrete progress on the active goal, or finish it.";
