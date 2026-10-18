/**
 * Skill discovery (S25).
 *
 * The loader (in the harness) owns what a `SKILL.md` means. What is tested here is *where to look*,
 * which is the part that needs to know about a machine: the tree up from the working directory, the
 * git root, every submodule root, and the user's own directory — deduped, closest first.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { NodeEnvironment } from "@eta/execution-node";
import { afterEach, describe, expect, it } from "vitest";
import { discoverSkillDirs, gitRepoChain, renderSkillsBlock } from "../src/skills";

const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "eta-skills-"));
	roots.push(root);
	// A symlinked temp directory would make `resolve` disagree with the paths written here.
	return resolve(root);
}

/** A skill directory with one skill in it. */
async function skill(root: string, name: string, description: string): Promise<void> {
	const directory = join(root, name);
	await mkdir(directory, { recursive: true });
	await writeFile(
		join(directory, "SKILL.md"),
		`---\nname: ${name}\ndescription: ${description}\n---\n\nDo the ${name} thing.\n`,
		"utf8",
	);
}

async function git(cwd: string, ...args: string[]): Promise<void> {
	const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: process.env });
	await child.exited;
}

describe("where skills live", () => {
	it("walks up from the working directory, closest first, and adds the user's own", async () => {
		const root = await scratch();
		const deep = join(root, "a", "b", "c");
		await mkdir(deep, { recursive: true });
		const home = join(root, "home");
		const dirs = discoverSkillDirs(deep, home);
		// Closest first: the directory the session is in, then each parent up to the filesystem root.
		expect(dirs[0]).toBe(join(deep, ".agents", "skills"));
		expect(dirs[1]).toBe(join(root, "a", "b", ".agents", "skills"));
		expect(dirs[2]).toBe(join(root, "a", ".agents", "skills"));
		// The user's own directory is in the list.
		expect(dirs).toContain(join(home, ".agents", "skills"));
		// And nothing is repeated: a directory visited twice would load its skills twice.
		expect(new Set(dirs).size).toBe(dirs.length);
	});

	it("adds the git root and every submodule root, recursively", async () => {
		const root = await scratch();
		const repo = join(root, "repo");
		const inner = join(repo, "packages", "inner");
		await mkdir(inner, { recursive: true });
		await git(repo, "init", "-q");
		// A submodule is named by its path in `.gitmodules`; the checkout itself need not exist for
		// discovery to know where its skills would live.
		await writeFile(join(repo, ".gitmodules"), '[submodule "inner"]\n\tpath = packages/inner\n\turl = x\n', "utf8");

		expect(gitRepoChain(inner)).toEqual([repo, join(repo, "packages", "inner")]);
		const dirs = discoverSkillDirs(inner, join(root, "home"));
		expect(dirs).toContain(join(repo, ".agents", "skills"));
		expect(dirs).toContain(join(repo, "packages", "inner", ".agents", "skills"));
		// The repo root's own directory is already in the upward walk: still one entry.
		expect(new Set(dirs).size).toBe(dirs.length);
	});

	it("has no repo chain outside a repository", async () => {
		const root = await scratch();
		expect(gitRepoChain(join(root, "not-a-repo"))).toEqual([]);
	});
});

describe("the catalog block", () => {
	it("renders the skills that apply, with their locations", async () => {
		const root = await scratch();
		const project = join(root, "project");
		await mkdir(project, { recursive: true });
		const skillsDir = join(project, ".agents", "skills");
		await skill(skillsDir, "porting", "How to port a module faithfully.");
		await skill(skillsDir, "shipping", "How to ship a slice.");

		const block = await renderSkillsBlock({
			env: new NodeEnvironment({ cwd: project }),
			cwd: project,
			home: join(root, "home"),
		});
		expect(block).toContain("<available_skills>");
		expect(block).toContain("<name>porting</name>");
		expect(block).toContain("How to port a module faithfully.");
		// The location is what makes progressive disclosure work: the model reads the file itself.
		expect(block).toContain(join(skillsDir, "porting", "SKILL.md"));
		expect(block).toContain("<name>shipping</name>");
	});

	it("is empty when no skill loads, rather than an empty block", async () => {
		const root = await scratch();
		const project = join(root, "bare");
		await mkdir(project, { recursive: true });
		expect(
			await renderSkillsBlock({
				env: new NodeEnvironment({ cwd: project }),
				cwd: project,
				home: join(root, "home"),
			}),
		).toBe("");
	});

	it("reports a skill it cannot parse instead of silently loading less", async () => {
		const root = await scratch();
		const project = join(root, "project");
		const skillsDir = join(project, ".agents", "skills");
		await mkdir(join(skillsDir, "broken"), { recursive: true });
		await writeFile(join(skillsDir, "broken", "SKILL.md"), "---\nname: [unclosed\n---\nbody\n", "utf8");
		await skill(skillsDir, "good", "A good one.");

		const warnings: string[] = [];
		const block = await renderSkillsBlock({
			env: new NodeEnvironment({ cwd: project }),
			cwd: project,
			home: join(root, "home"),
			warn: (message) => warnings.push(message),
		});
		expect(block).toContain("<name>good</name>");
		expect(block).not.toContain("broken");
		expect(warnings.some((message) => message.includes("broken"))).toBe(true);
	});

	it("sees a skill the moment it is written, with no restart", async () => {
		const root = await scratch();
		const project = join(root, "project");
		await mkdir(project, { recursive: true });
		const read = () =>
			renderSkillsBlock({ env: new NodeEnvironment({ cwd: project }), cwd: project, home: join(root, "home") });
		expect(await read()).toBe("");
		await skill(join(project, ".agents", "skills"), "newcomer", "Just arrived.");
		expect(await read()).toContain("<name>newcomer</name>");
	});
});
