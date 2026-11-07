// Ported from pi-mcp-adapter/types.ts (MIT, see ../NOTICE): the tool-name matching; one qualified name replaces its four prefix modes.
/**
 * How tools are named and matched.
 *
 * The model sees a server's own tool names. Policy layers (akhook) and direct tools see the
 * qualified `mcp__<server>__<tool>`. Matching is forgiving about the one thing models get wrong
 * constantly: hyphen against underscore.
 *
 * Reconstructed from pi-mcp-adapter's `types.ts` (MIT); its four prefix modes are replaced by this
 * single qualified form.
 */

/** `mcp__<server>__<tool>`, as policy rules see it. Unmodified so rules match the real names. */
export function qualifiedToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

/** Hyphens and underscores are the same character to a model; case is not folded. */
export function foldName(name: string): string {
  return name.replace(/-/g, "_");
}

/** `*` and `?` globs, anchored; everything else literal. */
export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

/** The names a configured pattern (include/exclude/approve/keywords) may use for a tool. */
function nameCandidates(server: string, tool: string): string[] {
  const names = [tool, qualifiedToolName(server, tool), `${server}_${tool}`];
  return [...new Set([...names, ...names.map(foldName)])];
}

/** Whether any pattern names this tool: exactly, by glob, hyphen/underscore-insensitively. */
export function matchesToolPattern(
  server: string,
  tool: string,
  patterns: readonly unknown[] | undefined,
): boolean {
  if (!Array.isArray(patterns) || patterns.length === 0) return false;
  const candidates = nameCandidates(server, tool);
  return patterns.some((pattern) => {
    if (typeof pattern !== "string") return false;
    const matcher = globToRegExp(foldName(pattern));
    return candidates.some((candidate) => matcher.test(candidate));
  });
}

export function isToolAllowed(
  server: string,
  tool: string,
  include: readonly string[] | undefined,
  exclude: readonly string[] | undefined,
): boolean {
  if (
    Array.isArray(include) &&
    include.length > 0 &&
    !matchesToolPattern(server, tool, include)
  ) {
    return false;
  }
  return !matchesToolPattern(server, tool, exclude);
}

export interface NamedTool {
  server: string;
  name: string;
}

/**
 * Resolves what a model typed to tools, best reading first: the exact tool name, the qualified
 * name, then the same two with hyphens and underscores folded. More than one hit at the best level
 * is returned as is, so the caller can ask which server was meant.
 */
export function findTools<T extends NamedTool>(
  requested: string,
  tools: readonly T[],
): T[] {
  const folded = foldName(requested);
  const levels: Array<(tool: T) => boolean> = [
    (tool) => tool.name === requested,
    (tool) => qualifiedToolName(tool.server, tool.name) === requested,
    (tool) => foldName(tool.name) === folded,
    (tool) =>
      foldName(qualifiedToolName(tool.server, tool.name)) === folded ||
      foldName(`${tool.server}_${tool.name}`) === folded,
  ];
  for (const level of levels) {
    const hits = tools.filter(level);
    if (hits.length > 0) return hits;
  }
  return [];
}
