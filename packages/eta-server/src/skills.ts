/**
 * Skill discovery: which skill directories apply to a session, and the catalog block they render.
 *
 * A skill is a directory with a `SKILL.md` in it (the loader in the harness owns what that file
 * means). What lives here is *where to look*, which is the part that needs the app's knowledge of
 * a machine:
 *
 * ```
 * <cwd>/.agents/skills            and every directory up the tree
 * <git root>/.agents/skills       and every submodule root, recursively
 * ~/.agents/skills                the user's own, everywhere
 * ```
 *
 * The order is deliberate — closest first — because the loader returns skills in the order it
 * found them and a nearer directory is a more specific answer to "how do I do this here".
 *
 * Two rules about the walk:
 *
 * - **Dedupe by directory.** Walking up from `/a/b/c` adds `/a/b/c/.agents/skills`,
 *   `/a/b/.agents/skills`, `/a/.agents/skills`, `/.agents/skills`; the git root and the home
 *   directory are usually already in that list, and a directory visited twice would load its
 *   skills twice.
 * - **Submodules are roots too.** A repo that vendors another repo has two places a skill can
 *   live, and a session working inside one of them should see both.
 *
 * Nothing here is cached: discovery is cheap (a few `existsSync` calls and a `.gitmodules` read),
 * and a cache would be a cache that has to be invalidated when a skill appears.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";

/** Every `.agents/skills` candidate for a cwd, deduped, closest first. */
export function discoverSkillDirs(cwd: string, home: string): string[] {
  const dirs = new Set<string>();
  let dir = resolve(cwd);
  const fsRoot = parse(dir).root;
  for (;;) {
    dirs.add(join(dir, ".agents", "skills"));
    if (dir === fsRoot) break;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  dirs.add(join(home, ".agents", "skills"));
  for (const repo of gitRepoChain(cwd))
    dirs.add(join(repo, ".agents", "skills"));
  return [...dirs];
}

/** The git repository containing `cwd`, plus every (recursively nested) submodule root. */
export function gitRepoChain(cwd: string): string[] {
  let dir = resolve(cwd);
  const fsRoot = parse(dir).root;
  let repo: string | undefined;
  for (;;) {
    if (existsSync(join(dir, ".git"))) {
      repo = dir;
      break;
    }
    if (dir === fsRoot) break;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  if (repo === undefined) return [];
  const out = [repo];
  const queue = [repo];
  while (queue.length > 0) {
    const base = queue.shift() as string;
    let text = "";
    try {
      text = readFileSync(join(base, ".gitmodules"), "utf8");
    } catch {
      /* no .gitmodules */
    }
    // eslint-disable-next-line regexp/no-super-linear-backtracking -- a local .gitmodules; a rewrite could change what matches
    for (const match of text.matchAll(/^\s*path\s*=\s*(.+)$/gm)) {
      const sub = resolve(base, (match[1] ?? "").trim());
      if (out.includes(sub)) continue;
      out.push(sub);
      queue.push(sub);
    }
  }
  return out;
}

export interface RenderSkillsOptions {
  cwd: string;
  home: string;
  /** Skill directories beyond the discovered ones (a bundle's), looked at after them. */
  extraDirs?: readonly string[] | undefined;
  /** Diagnostics from the loader: a skill that would not parse, a directory that would not list. */
  warn?: ((message: string) => void) | undefined;
}

/**
 * The catalog block a model sees, or `""` when nothing loads.
 *
 * The block lists names, descriptions and *locations*: the model reads the file when a task
 * matches. That is progressive disclosure, and it is why the block stays small enough to sit in
 * the stable part of the prompt.
 */
export async function renderSkillsBlock(
  options: RenderSkillsOptions,
): Promise<string> {
  // The loader is imported here rather than at the top so this file can be used (and its directory
  // walk tested) without pulling in the harness's YAML and ignore-file machinery.
  const { formatSkillsForSystemPrompt, loadSkills } = await import(
    "@eta/harness"
  );
  const { skills, diagnostics } = await loadSkills([
    ...discoverSkillDirs(options.cwd, options.home),
    ...(options.extraDirs ?? []),
  ]);
  for (const diagnostic of diagnostics)
    options.warn?.(`[eta-skills] ${diagnostic.path}: ${diagnostic.message}`);
  return formatSkillsForSystemPrompt(skills);
}
