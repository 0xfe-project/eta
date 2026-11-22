// What a paste is, from its text and HTML alone: Markdown, or code from an editor. No imports:
// `composer-doc`'s clipboard rules use these.

const lines = (text: string) => text.replace(/\r\n?/g, "\n").split("\n");

/** Whether text has a Markdown heading, fence, quote or task line: Markdown, however long. */
export function hasMarkdownBlocks(text: string): boolean {
  return lines(text).some(
    (line) =>
      /^#{1,6}\s+\S/.test(line) ||
      /^\s{0,3}(?:`{3,}|~{3,})/.test(line) ||
      /^\s{0,3}>\s/.test(line) ||
      /^\s{0,3}[-*+]\s+\[[ x]\]\s/i.test(line),
  );
}

/**
 * Whether pasted text is Markdown to show formatted: a heading, a fence, a quote, a list or a
 * task, or bold, inline code or a link in a line. Plain prose and logs are not.
 */
export function looksLikeMarkdown(text: string): boolean {
  if (hasMarkdownBlocks(text)) return true;
  const rows = lines(text);
  const listLines = rows.filter((line) =>
    /^\s{0,3}(?:[-*+]|\d{1,3}[.)])\s+\S/.test(line),
  ).length;
  if (listLines >= 2) return true;
  return rows.some(
    (line) =>
      /\*\*[^*\s][^*]*\*\*/.test(line) ||
      /(?:^|[^`])`[^`\s][^`]*`/.test(line) ||
      /\[[^\]]+\]\([^)\s]+\)/.test(line),
  );
}

/**
 * Whether a copy is code from an editor or an IDE (VS Code, JetBrains, Xcode): its HTML is
 * preformatted text in a monospace face. Plain text alone does not say.
 */
export function isEditorCode(html: string | undefined): boolean {
  if (!html) return false;
  const pre = /white-space:\s*pre\b/i.test(html) || /<pre[\s>]/i.test(html);
  const mono = /font-family:[^;"]*(?:mono|courier|menlo|consolas)/i.test(html);
  return pre && mono;
}
