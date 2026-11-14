import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Agent } from "../../src/realm/agent";

describe("eta module imports", () => {
  let selfDir: string;
  let projectDir: string;
  let globalDir: string;

  beforeEach(() => {
    const base = join(tmpdir(), `eta-modules-test-${Date.now()}`);
    selfDir = join(base, "self");
    projectDir = join(base, "project");
    globalDir = join(base, "global");

    for (const dir of [selfDir, projectDir, globalDir]) {
      mkdirSync(dir, { recursive: true });
    }
  });

  afterEach(() => {
    const base = join(selfDir, "..");
    rmSync(base, { recursive: true, force: true });
  });

  it("can import capability from project layer with eta:project:name", async () => {
    // Project layer defines shout
    writeFileSync(
      join(projectDir, "env.js"),
      `// @capabilities [{"name":"shout","source":"(text) => text.toUpperCase()","meta":{}}]\n` +
        `import eta from "eta";\n\n` +
        `// eta:generated\n\n` +
        `// eta:capability shout\n` +
        `eta.define("shout", (text) => text.toUpperCase(), {});\n` +
        `// eta:end\n\n` +
        `// eta:by hand\n`,
    );

    // Self layer is empty
    writeFileSync(
      join(selfDir, "env.js"),
      `// @capabilities []\nimport eta from "eta";\n\n// eta:generated\n\n// eta:by hand\n`,
    );

    const agent = new Agent({
      root: selfDir,
      project: projectDir,
    });

    // User code imports from project layer explicitly
    const result = await agent.run(
      `import shout from "eta:project:shout";\nexport default shout("hello");`,
    );

    expect(result.value).toBe("HELLO");
  });

  it("self layer can import from project layer with eta:project:name", async () => {
    // Project layer defines shout
    writeFileSync(
      join(projectDir, "env.js"),
      `// @capabilities [{"name":"shout","source":"(text) => text.toUpperCase()","meta":{}}]\n` +
        `import eta from "eta";\n\n` +
        `// eta:generated\n\n` +
        `// eta:capability shout\n` +
        `eta.define("shout", (text) => text.toUpperCase(), {});\n` +
        `// eta:end\n\n` +
        `// eta:by hand\n`,
    );

    // Self layer's own env.js imports outward, from the project layer.
    writeFileSync(
      join(selfDir, "env.js"),
      `import shout from "eta:project:shout";\n\n` +
        `// @capabilities []\n` +
        `import eta from "eta";\n\n` +
        `// eta:generated\n\n` +
        `// eta:by hand\n` +
        `eta.define("loud", (text) => shout(text) + "!", {});\n`,
    );

    const agent = new Agent({
      root: selfDir,
      project: projectDir,
    });

    const result = await agent.run(
      `import loud from "eta:loud";\nexport default loud("hello from self");`,
    );

    expect(result.value).toBe("HELLO FROM SELF!");
  });

  it("blocks inward resolution: project cannot import from self", async () => {
    // Self layer defines 'whisper'
    writeFileSync(
      join(selfDir, "env.js"),
      `// @capabilities [{"name":"whisper","source":"(text) => text.toLowerCase()","meta":{}}]\n` +
        `import eta from "eta";\n\n` +
        `// eta:generated\n\n` +
        `// eta:capability whisper\n` +
        `eta.define("whisper", (text) => text.toLowerCase(), {});\n` +
        `// eta:end\n\n` +
        `// eta:by hand\n`,
    );

    // Project layer tries to import from self layer - this should fail!
    writeFileSync(
      join(projectDir, "env.js"),
      `import whisper from "eta:self:whisper";\n\n` +
        `// @capabilities []\n` +
        `import eta from "eta";\n\n` +
        `// eta:generated\n\n` +
        `// eta:by hand\n`,
    );

    const agent = new Agent({
      root: selfDir,
      project: projectDir,
    });

    // The agent should fail to wake because project layer's env.js cannot import from self
    await expect(
      agent.run(`export default "should not reach here"`),
    ).rejects.toThrow(/Layer project cannot import from layer self/);
  });

  it("eta:name resolves by priority: project before global", async () => {
    // Global layer defines format
    writeFileSync(
      join(globalDir, "env.js"),
      `// @capabilities [{"name":"format","source":"(x) => \\"global: \\" + x","meta":{}}]\n` +
        `import eta from "eta";\n\n` +
        `// eta:generated\n\n` +
        `// eta:capability format\n` +
        `eta.define("format", (x) => "global: " + x, {});\n` +
        `// eta:end\n\n` +
        `// eta:by hand\n`,
    );

    // Project layer also defines format
    writeFileSync(
      join(projectDir, "env.js"),
      `// @capabilities [{"name":"format","source":"(x) => \\"project: \\" + x","meta":{}}]\n` +
        `import eta from "eta";\n\n` +
        `// eta:generated\n\n` +
        `// eta:capability format\n` +
        `eta.define("format", (x) => "project: " + x, {});\n` +
        `// eta:end\n\n` +
        `// eta:by hand\n`,
    );

    // Self layer is empty
    writeFileSync(
      join(selfDir, "env.js"),
      `// @capabilities []\nimport eta from "eta";\n\n// eta:generated\n\n// eta:by hand\n`,
    );

    const agent = new Agent({
      root: selfDir,
      project: projectDir,
      global: globalDir,
    });

    // Import without layer specifier should resolve to project (since self is empty)
    const result = await agent.run(
      `import format from "eta:format";\nexport default format(42);`,
    );

    expect(result.value).toBe("project: 42");
  });

  it("eta:name falls back to lower priority when higher layer doesn't have it", async () => {
    // Only global layer has format
    writeFileSync(
      join(globalDir, "env.js"),
      `// @capabilities [{"name":"format","source":"(x) => \\"from global\\"","meta":{}}]\n` +
        `import eta from "eta";\n\n` +
        `// eta:generated\n\n` +
        `// eta:capability format\n` +
        `eta.define("format", (x) => "from global", {});\n` +
        `// eta:end\n\n` +
        `// eta:by hand\n`,
    );

    // Project and self layers are empty
    writeFileSync(
      join(projectDir, "env.js"),
      `// @capabilities []\nimport eta from "eta";\n\n// eta:generated\n\n// eta:by hand\n`,
    );
    writeFileSync(
      join(selfDir, "env.js"),
      `// @capabilities []\nimport eta from "eta";\n\n// eta:generated\n\n// eta:by hand\n`,
    );

    const agent = new Agent({
      root: selfDir,
      project: projectDir,
      global: globalDir,
    });

    // Should resolve to global layer
    const result = await agent.run(
      `import format from "eta:format";\nexport default format(42);`,
    );

    expect(result.value).toBe("from global");
  });

  it("cache key includes layer name, so one name in two layers stays two modules", async () => {
    const define = (value: string) =>
      `// @capabilities [{"name":"shout","source":"(text) => \\"${value}\\"","meta":{}}]\n` +
      `import eta from "eta";\n\n` +
      `// eta:generated\n\n` +
      `// eta:capability shout\n` +
      `eta.define("shout", (text) => "${value}", {});\n` +
      `// eta:end\n\n` +
      `// eta:by hand\n`;
    writeFileSync(join(projectDir, "env.js"), define("PROJECT"));
    writeFileSync(join(selfDir, "env.js"), define("SELF"));

    const agent = new Agent({ root: selfDir, project: projectDir });
    // One realm, one module cache: whichever is linked first must not answer for the other.
    const result = await agent.run(
      `import fromProject from "eta:project:shout";\n` +
        `import nearest from "eta:shout";\n` +
        `export default [fromProject("x"), nearest("x")];`,
    );

    expect(result.value).toEqual(["PROJECT", "SELF"]);
  });
});
