import type { AgentTemplate } from "./template";

// A role card of unicodef1wn/grokbot-field-notes is Markdown: `# Name (note)`,
// `**Category:** …`, a paragraph on what it is, the lists under `## Owns`, `## Does not own` and
// `## Needs approval for`, and under `## Role description — …` a fenced block with
// `{PLACEHOLDERS}`, the text the card means to be pasted into a new bot. Who played the role on
// stream and what was said there stay out. `scripts/agent-templates.ts` writes the catalog with it.

const categoryLabel = "**Category:**";
const roleSection = "Role description — paste and fill the placeholders";

/** The lines of section `title`, up to the next `## `. */
function section(lines: string[], title: string): string[] {
  const start = lines.findIndex((line) => line.trim() === `## ${title}`);
  if (start === -1) return [];
  const end = lines.findIndex(
    (line, index) => index > start && line.startsWith("## "),
  );
  return lines.slice(start + 1, end === -1 ? undefined : end);
}

const bullets = (lines: string[]) =>
  lines.filter((line) => line.startsWith("- ")).map((line) => line.slice(2));

/** Text wrapped by hand at a fixed width as running lines again: a list item or a line after a
 * blank one starts a new line, the rest join the line before. */
export function unwrap(text: string): string {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const previous = out[out.length - 1];
    const starts = !line.trim() || /^\s*(?:[-*]|\d+[.)])\s/.test(line);
    if (previous === undefined || !previous.trim() || starts) out.push(line);
    else out[out.length - 1] = `${previous} ${line.trim()}`;
  }
  return out.join("\n");
}

/** The template a role card file (`<id>.md`) describes; throws when it is not a role card. */
export function parseRoleCard(file: string, markdown: string): AgentTemplate {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const title = /^# (.+?)(?: \((.+)\))?$/.exec(lines[0] ?? "");
  const category = lines
    .find((line) => line.startsWith(categoryLabel))
    ?.slice(categoryLabel.length)
    .trim();
  const role = section(lines, roleSection);
  const fence = role.findIndex((line) => line.startsWith("```"));
  const close = role.findIndex(
    (line, index) => index > fence && line.startsWith("```"),
  );
  if (!title || !category || fence === -1 || close === -1)
    throw new Error(`${file}: not a role card`);
  // The paragraph after the name and the `**…:**` lines.
  const body = lines.slice(1);
  const first = body.findIndex((line) => line.trim() && !line.startsWith("**"));
  const last = body.findIndex((line, index) => index > first && !line.trim());
  return {
    id: file.replace(/\.md$/, ""),
    name: title[1]!,
    ...(title[2] ? { note: title[2] } : {}),
    category,
    summary: body
      .slice(first, last === -1 ? undefined : last)
      .join(" ")
      .trim(),
    owns: bullets(section(lines, "Owns")),
    doesNotOwn: bullets(section(lines, "Does not own")),
    needsApproval: bullets(section(lines, "Needs approval for")),
    instructions: unwrap(
      role
        .slice(fence + 1, close)
        .join("\n")
        .trim(),
    ),
  };
}
