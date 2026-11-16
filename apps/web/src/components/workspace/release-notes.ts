// The first points of a release's notes, as plain words for Settings → Update. GitHub's generated
// notes are a list of pull requests, each "* type(scope): title by @who in <link>".

const PREFIX = /^[a-z]+(?:\([^)]*\))?!?:\s+/i;
/** GitHub's generated notes end each line with who and where: "by @x in https://…". */
const CREDIT = /\s+by @\S+ in \S+$/;

/** A line of Markdown as plain words: no link targets, emphasis or tags. */
const plain = (line: string): string =>
  line
    .replaceAll(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replaceAll(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replaceAll(/<[^>]+>/g, "")
    .replaceAll(/\*\*|__|`/g, "")
    .replace(CREDIT, "")
    .replace(PREFIX, "")
    .trim();

/**
 * The first few points of a release's notes: its list items, or its lines when it has no list.
 * Headings are left out; the page has the rest.
 */
export function noteItems(text: string, max = 5): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const bullets = lines
    .filter((line) => /^[-*+]\s+/.test(line))
    .map((line) => line.replace(/^[-*+]\s+/, ""));
  const chosen =
    bullets.length > 0
      ? bullets
      : lines.filter((line) => !line.startsWith("#"));
  // Each once: they key the list.
  return [...new Set(chosen.map(plain).filter((line) => line !== ""))].slice(
    0,
    max,
  );
}
