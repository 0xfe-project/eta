/**
 * Memory extraction prompts (verbatim port of evo.rs).
 */

/** Prompt for the out-of-band memory extraction call. */
export const MEMORY_EXTRACT_PROMPT = `Read the conversation. Extract what the user wants that's worth remembering, into these sections:

- decision: the user's HARD requirements / musts
- preference: weaker, how they like it
- lesson: from failures and negative feedback

Ignore small talk. Only capture durable, reusable things.

Output ONLY a JSON object:
{"add_new_decision": ["..."], "add_new_preference": ["..."], "learn_new_lesson": ["..."], "remove_memory_ids": [0]}

If nothing is worth keeping, output the same object with all empty arrays.`;

export const MEMORY_EXTRACT_SYSTEM_PROMPT =
	"You are a memory extractor for a coding assistant. Be terse and specific.";
