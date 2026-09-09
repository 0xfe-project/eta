/**
 * Goal prompts (verbatim port of goal.rs).
 */

/** Guidelines injected into the context while an agent pursues a goal. */
export function goalPursuitGuidelines(objective: string): string {
	return `Goal: ${objective}

Continuation:
- Goal persists across turns. Don't shrink the objective to fit now.
- Make concrete progress toward the real end state. Leave goal active if unfinished.

Progress:
- If multi-step, keep <current_tasks>...</current_tasks> tied to the objective. Update as steps complete. Skip for trivial one-step work. A plan update is NOT the work.

Completion:
- Only mark done when the end state is verified. Don't mark done just because you're stopping.`;
}

/** Goal evaluator: a tool-free call that judges whether the goal is achieved. */
export function goalEvaluatorPrompt(objective: string): string {
	return `Is the goal achieved? Goal: "${objective}". Reply YES or NO only.`;
}
