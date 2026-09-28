/**
 * Every model-visible string the harness owns, one file per topic.
 *
 * Core owns none of these: the kernel's primitives, the runner, and the seams
 * hold no prompt text, so this directory is the whole of what an agent says
 * about itself. Tool descriptions belong to their tools; a plugin's prompt (the
 * compaction summarizer's, say) belongs to that plugin.
 */
export * from "./base";
export * from "./composer";
export * from "./goal";
export * from "./memory";
export * from "./persona";
export * from "./platform";
export * from "./skills-block";
export * from "./tasks";
