/**
 * Resume reminders (verbatim port of resume.rs).
 */

/** Resume / retry reminders injected when the engine recovers from a stuck state. */
export const RESUME = "[resume] continue";
export const RESUME_TRUNCATED = "[resume] output was truncated, continue in smaller chunks";
export const RESUME_EMPTY = "[resume] no output produced, continue";
export const RESUME_LOOP = "[resume] detected a loop, try a different approach";
