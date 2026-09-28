/**
 * Loading skills (ported from eta-agent's `test/harness/skills.test.ts`).
 *
 * Two things this has to get right. First, a skill is found by the same rules a
 * shell would use — including the ignore files — so a directory of procedures
 * behaves like a directory of files. Second, and less obvious: what could not be
 * read is *reported*. A skill that fails to parse, or whose frontmatter does not
 * match its directory, is a warning with a path rather than a quiet absence the
 * user cannot explain away.
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NodeEnvironment } from "../src/env/node-shell";
import { formatSkillInvocation } from "../src/prompt-blocks";
import { loadSkills, loadSourcedSkills } from "../src/skills";

let root = "";
let env: NodeEnvironment;

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "eta-skills-"));
	env = new NodeEnvironment({ cwd: root });
});

afterAll(async () => {
	await env.cleanup();
	await rm(root, { recursive: true, force: true });
});

/** Write a file, creating its parents — the fixture needs to say exactly this. */
async function put(path: string, content: string): Promise<void> {
	const absolute = join(root, path);
	await mkdir(dirname(absolute), { recursive: true });
	await writeFile(absolute, content);
}

describe("loadSkills", () => {
	it("loads a SKILL.md through the environment, frontmatter and all", async () => {
		await put(
			".agents/skills/example/SKILL.md",
			`---
name: example
description: Example skill
disable-model-invocation: true
---
Use this skill.
`,
		);
		const { skills, diagnostics } = await loadSkills(env, ".agents/skills");
		expect(diagnostics).toEqual([]);
		expect(skills).toEqual([
			{
				name: "example",
				description: "Example skill",
				content: "Use this skill.",
				filePath: join(root, ".agents/skills/example/SKILL.md"),
				disableModelInvocation: true,
			},
		]);
	});

	it("reports a mismatch between the name and its directory, and still loads it", async () => {
		await put(
			".agents/skills/other/SKILL.md",
			`---
name: not-the-directory
description: A skill whose name disagrees with where it lives
---
Body.
`,
		);
		const loaded = await loadSkills(env, ".agents/skills/other");
		// The card is usable, and the inconsistency is visible rather than silent.
		expect(loaded.skills.map((skill) => skill.name)).toEqual(["not-the-directory"]);
		expect(loaded.diagnostics.map((diagnostic) => diagnostic.code)).toContain("invalid_metadata");
		expect(loaded.diagnostics[0]?.path).toContain("SKILL.md");
	});

	it("keeps a missing directory quiet, and a broken SKILL.md loud", async () => {
		const missing = await loadSkills(env, "no/such/dir");
		expect(missing).toEqual({ skills: [], diagnostics: [] });

		await put(
			".agents/skills/broken/SKILL.md",
			`---
name: broken
description: "unterminated [yaml
---
Body.
`,
		);
		const broken = await loadSkills(env, ".agents/skills/broken");
		expect(broken.skills).toEqual([]);
		expect(broken.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["parse_failed"]);
	});

	it("honours ignore files, and hides dot directories and node_modules", async () => {
		await put(".agents/skills/.gitignore", "# a comment\nignored/\n");
		await put(".agents/skills/ignored/SKILL.md", "---\nname: ignored\ndescription: should not load\n---\nBody.\n");
		await put(".agents/skills/.hidden/SKILL.md", "---\nname: hidden\ndescription: hidden\n---\nBody.\n");
		await put(".agents/skills/node_modules/pkg/SKILL.md", "---\nname: pkg\ndescription: dependency\n---\nBody.\n");
		const loaded = await loadSkills(env, ".agents/skills");
		expect(loaded.skills.map((skill) => skill.name).sort()).toEqual(["example", "not-the-directory"]);
	});

	it("loads direct markdown children only from the root, and only when they declare a skill", async () => {
		await put(
			".agents/skills/root-is-a-skill.md",
			"---\nname: root-is-a-skill\ndescription: at the root\n---\nBody.\n",
		);
		await put(".agents/skills/notes.md", "# Just notes\n\nNo frontmatter at all.\n");
		await put(
			".agents/skills/example/nested/notes.md",
			"---\nname: nested-notes\ndescription: nested markdown is not a skill\n---\nBody.\n",
		);
		const names = (await loadSkills(env, ".agents/skills")).skills.map((skill) => skill.name);
		expect(names).toContain("root-is-a-skill");
		// A root markdown file with no description is documentation, not a skill;
		// and a `.md` under a skill directory is never scanned as one.
		expect(names).not.toContain("notes");
		expect(names).not.toContain("nested-notes");
	});

	it("loads through a symlinked directory", async () => {
		await put("real/pack/SKILL.md", "---\nname: pack\ndescription: through a link\n---\nBody.\n");
		await symlink(join(root, "real"), join(root, "linked"));
		const loaded = await loadSkills(env, "linked");
		expect(loaded.skills.map((skill) => skill.name)).toEqual(["pack"]);
	});

	it("carries a caller's provenance through, on skills and on diagnostics", async () => {
		await put("sourced/good/SKILL.md", "---\nname: good\ndescription: fine\n---\nBody.\n");
		await put("sourced/bad/SKILL.md", "---\nname: bad\n---\nBody.\n");
		const { skills, diagnostics } = await loadSourcedSkills(env, [{ path: "sourced", source: "user" }], undefined);
		expect(skills.map((entry) => [entry.skill.name, entry.source])).toEqual([["good", "user"]]);
		// The broken one is still reported, with where it came from.
		expect(diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.source])).toEqual([
			["invalid_metadata", "user"],
		]);
	});
});

describe("formatting an invocation", () => {
	it("hands over the skill, its location, and where its references are relative to", () => {
		const skill = {
			name: "porting",
			description: "How to port faithfully",
			content: "Read the source, then write it again.",
			filePath: "/skills/porting/SKILL.md",
		};
		expect(formatSkillInvocation(skill)).toBe(
			`<skill name="porting" location="/skills/porting/SKILL.md">\nReferences are relative to /skills/porting.\n\nRead the source, then write it again.\n</skill>`,
		);
		expect(formatSkillInvocation(skill, "also rename the file")).toContain("also rename the file");
	});
});
