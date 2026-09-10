/**
 * Skill discovery: walk up from cwd collecting `.agents/skills` at every level,
 * plus `~/.agents/skills`, the git repo root, and every git submodule root.
 * The catalog block is compact (`- name desc… : dir`) so it stays cheap in the
 * stable prompt block; fs.watch on the discovered trees hot-reloads it.
 */

import { existsSync, readFileSync, watch as fsWatch } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { BACKGROUND_CONTEXT, loadSkills, type ExecutionEnv } from "@eta/core";

/** Every `.agents/skills` candidate for a cwd, deduped, closest-first-ish. */
export function discoverSkillDirs(cwd: string, home = homedir()): string[] {
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
	for (const repo of gitRepoChain(cwd)) dirs.add(join(repo, ".agents", "skills"));
	return [...dirs];
}

/** The git repo containing cwd plus every (recursively nested) submodule root. */
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
		const base = queue.shift()!;
		let text = "";
		try {
			text = readFileSync(join(base, ".gitmodules"), "utf8");
		} catch {
			/* no .gitmodules */
		}
		for (const m of text.matchAll(/^\s*path\s*=\s*(.+)$/gm)) {
			const sub = resolve(base, m[1]!.trim());
			if (out.includes(sub)) continue;
			out.push(sub);
			queue.push(sub);
		}
	}
	return out;
}

/** Compact catalog for the system prompt; "" when no skill loads. */
export async function renderSkillsBlock(env: ExecutionEnv, cwd: string, home = homedir()): Promise<string> {
	const { skills } = await loadSkills(env, discoverSkillDirs(cwd, home), BACKGROUND_CONTEXT);
	const lines: string[] = [];
	const seen = new Set<string>();
	for (const skill of skills) {
		if (skill.disableModelInvocation === true) continue;
		const dir = dirname(skill.filePath);
		const desc = (skill.description ?? "")
			.replace(/[\r\n]+/g, " ")
			.trim()
			.slice(0, 100);
		const line = `- ${skill.name} ${desc} : ${dir}`;
		if (seen.has(line)) continue;
		seen.add(line);
		lines.push(line);
	}
	if (lines.length === 0) return "";
	return ["<skills>", ...lines, "</skills>"].join("\n");
}

/** Watch every discovered dir (falling back to the closest existing ancestor) and fire onChange. */
export function watchSkillDirs(dirs: string[], onChange: () => void): void {
	const watched = new Set<string>();
	for (const dir of dirs) {
		let probe = resolve(dir);
		for (;;) {
			if (watched.has(probe)) break;
			try {
				const watcher = fsWatch(probe, { persistent: false }, () => onChange());
				watcher.on("error", () => {
					/* watch degrades to rescan-on-next-session */
				});
				watched.add(probe);
				break;
			} catch {
				const up = dirname(probe);
				if (up === probe) break;
				probe = up;
			}
		}
	}
}
