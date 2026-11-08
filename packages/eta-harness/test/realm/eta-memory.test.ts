import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Agent } from "../../src/realm/agent";

const EMPTY_ENV = `// @capabilities []\nimport eta from "eta";\n\n// eta:generated\n\n// eta:by hand\n`;

describe("eta:{layer}:memory in a realm", () => {
  let base: string;
  let selfDir: string;
  let projectDir: string;
  let globalDir: string;
  let agent: Agent;

  beforeEach(() => {
    base = join(tmpdir(), `eta-memory-realm-${Date.now()}-${Math.random()}`);
    selfDir = join(base, "sessions", "s1");
    projectDir = join(base, "proj", ".eta");
    globalDir = join(base, "global");
    for (const dir of [selfDir, projectDir, globalDir]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "env.js"), EMPTY_ENV);
    }
    agent = new Agent({
      root: selfDir,
      project: projectDir,
      global: globalDir,
    });
  });

  afterEach(() => {
    agent.dispose();
    rmSync(base, { recursive: true, force: true });
  });

  it('import mem from "eta:project:memory": add / list / get / remove', async () => {
    const result = await agent.run(
      `import mem from "eta:project:memory";\n` +
        `const a = await mem.add("decision", "push to main");\n` +
        `const b = await mem.add("preference", "Use Chinese");\n` +
        `const removed = await mem.remove(b);\n` +
        `export default { a, removed, got: mem.get(a), all: mem.list(), prefs: mem.list("preference") };`,
    );
    const value = result.value as {
      a: string;
      removed: boolean;
      got: { text: string; section: string };
      all: unknown[];
      prefs: unknown[];
    };
    expect(value.a).toMatch(/^proj~[0-9a-f]{4}#0$/);
    expect(value.removed).toBe(true);
    expect(value.got).toMatchObject({
      text: "push to main",
      section: "decision",
    });
    expect(value.all).toHaveLength(1);
    expect(value.prefs).toHaveLength(0);
    expect(readFileSync(join(projectDir, "MEMORY.md"), "utf8")).toContain(
      `- [${value.a}] push to main`,
    );
  });

  it("each layer writes its own MEMORY.md, next to its env.js", async () => {
    await agent.run(
      `import self from "eta:self:memory";\n` +
        `import { add } from "eta:global:memory";\n` +
        `await self.add("lesson", "mine");\n` +
        `await add("lesson", "everyone's");\n` +
        `export default 0;`,
    );
    expect(readFileSync(join(selfDir, "MEMORY.md"), "utf8")).toContain("mine");
    expect(readFileSync(join(globalDir, "MEMORY.md"), "utf8")).toContain(
      "everyone's",
    );
    const project = await agent.run(
      `import mem from "eta:project:memory";\nexport default mem.list().length;`,
    );
    expect(project.value).toBe(0);
  });

  it("a hand edit of MEMORY.md shows up on the next read", async () => {
    const path = join(projectDir, "MEMORY.md");
    writeFileSync(path, "## decision\n- [proj~0000#4] written by a human\n");
    const read = `import mem from "eta:project:memory";\nexport default mem.list().map((e) => e.text);`;
    expect((await agent.run(read)).value).toEqual(["written by a human"]);

    writeFileSync(path, "## lesson\n- edited again\n");
    expect((await agent.run(read)).value).toEqual(["edited again"]);
  });

  it("entries belong to the realm, so they are no way out to the host", async () => {
    const result = await agent.run(
      `import mem from "eta:project:memory";\n` +
        `await mem.add("lesson", "x");\n` +
        `const [e] = mem.list();\n` +
        `export default [e.constructor === Object, mem.list.constructor === Function];`,
    );
    // `process` itself is a host object now: the passthrough layer mounts it on
    // purpose (mountNodeGlobals), and esm-mode.test.ts pins that separately.
    expect(result.value).toEqual([true, true]);
  });

  it("add is recorded on the effect ledger", async () => {
    const result = await agent.run(
      `import mem from "eta:self:memory";\nawait mem.add("lesson", "noted");\nexport default 0;`,
    );
    expect(result.effects.map((e) => e.name)).toContain("eta.memory.add");
  });
});
