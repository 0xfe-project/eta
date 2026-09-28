/**
 * The skills catalog block (verbatim port of eta-agent's
 * `harness/system-prompt.ts`).
 *
 * One block listing the skills a model may invoke, in the XML shape
 * agentskills.io suggests. A skill can opt out of the listing
 * (`disableModelInvocation`) while still being usable when a user names it.
 */
/** A skill as the catalog needs it: what it is called, when to use it, and where it lives. */
export interface CatalogSkill {
	name: string;
	description: string;
	filePath: string;
	/** Keep it out of the model-visible list (a user may still invoke it explicitly). */
	disableModelInvocation?: boolean | undefined;
}

export function formatSkillsForSystemPrompt(skills: readonly CatalogSkill[]): string {
	const visibleSkills = skills.filter((skill) => !skill.disableModelInvocation);
	if (visibleSkills.length === 0) return "";

	const lines = [
		"The following skills provide specialized instructions for specific tasks.",
		"Read the full skill file when the task matches its description.",
		"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
		"",
		"<available_skills>",
	];

	for (const skill of visibleSkills) {
		lines.push("  <skill>");
		lines.push(`    <name>${escapeXml(skill.name)}</name>`);
		lines.push(`    <description>${escapeXml(skill.description)}</description>`);
		lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
		lines.push("  </skill>");
	}

	lines.push("</available_skills>");
	return lines.join("\n");
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}
