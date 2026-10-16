/**
 * Pure prompt-text blocks (port of eta-agent's `harness/prompt-blocks.ts`).
 *
 * Formatting a skill invocation lives here rather than with the loader, so
 * anything that wants to *say* a skill can do it without loading any.
 */
import type { Skill } from "./skills";

/** Format a skill invocation prompt, optionally appending additional user instructions. */
export function formatSkillInvocation(
  skill: Skill,
  additionalInstructions?: string,
): string {
  const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${dirnameEnvPath(skill.filePath)}.\n\n${skill.content}\n</skill>`;
  return additionalInstructions
    ? `${skillBlock}\n\n${additionalInstructions}`
    : skillBlock;
}

export function dirnameEnvPath(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const separatorIndex = Math.max(
    normalized.lastIndexOf("/"),
    normalized.lastIndexOf("\\"),
  );
  if (separatorIndex === 2 && normalized[1] === ":")
    return normalized.slice(0, 3);
  return separatorIndex <= 0 ? "/" : normalized.slice(0, separatorIndex);
}
