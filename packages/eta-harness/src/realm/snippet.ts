/**
 * What the model writes is a snippet, not a module (Eta #288): a few statements
 * and then the expression whose value is the answer, the way a REPL reads it.
 * `export default` is not how it says "this is the result".
 *
 * The snippet still runs as a real module (top-level `await`, `import`), so
 * the only thing done here is to find the trailing expression and make it the
 * default export. No parser: each candidate split is asked of V8 itself
 * ({@link parses}), from the largest tail down, and the first one that parses
 * wins. Line numbers are kept: `export default (` goes on the tail's own first
 * line and the closing paren on a line after the last one.
 *
 * A snippet that already exports something is a module and is left alone, as
 * is one whose last statement is not an expression (it simply has no value).
 */
export function snippetSource(
  source: string,
  parses: (source: string) => boolean,
): string {
  if (/^\s*export\s/m.test(source)) return source;
  const lines = source.replace(/\s+$/, "").split("\n");
  // A tail longer than this is a statement list, not an expression; the bound
  // only keeps a long script from costing a few hundred parses.
  const deepest = Math.max(0, lines.length - 40);
  for (let at = 0; at < lines.length; at++) {
    if (at > 0 && at < deepest) continue;
    const head = lines.slice(0, at).join("\n");
    const tail = lines.slice(at).join("\n");
    if (
      tail.trim() === "" ||
      /^\s*(?:import|const|let|var|function|class|if|for|while|try|return|throw)\b/.test(
        tail,
      )
    )
      continue;
    const body = tail.replace(/;\s*$/, "");
    const candidate = `${head}${at > 0 ? "\n" : ""}export default (${body}\n);\n`;
    if (parses(candidate)) return candidate;
  }
  return source;
}
