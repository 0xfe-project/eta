/**
 * Memory extraction prompts (verbatim port of eta-agent's `prompts/evo.ts`,
 * itself evo.rs).
 *
 * The extraction call is out of band: the agent never sees it, so these strings
 * are the only thing shaping what gets remembered.
 */

/** Prompt for the out-of-band memory extraction call. */
export const MEMORY_EXTRACT_PROMPT = `Read the conversation. Extract what the user wants that's worth remembering, into these sections:

- decision: the user's HARD requirements / musts
- preference: weaker, how they like it
- lesson: from failures and negative feedback

Ignore small talk. Only capture durable, reusable things.

Output ONLY a JSON object:
{"add_new_decision": ["..."], "add_new_preference": ["..."], "learn_new_lesson": ["..."], "remove_memory_ids": ["user#0"]}

Notes are shown with an id like [user#1] or [eta-agent~9f3c#0]. Copy those ids into remove_memory_ids exactly as shown; an id from a file this call is not writing to is ignored.

If nothing is worth keeping, output the same object with all empty arrays.`;

export const MEMORY_EXTRACT_SYSTEM_PROMPT =
  "You keep notes on what's worth remembering about this person and their work. Be terse and specific.";
