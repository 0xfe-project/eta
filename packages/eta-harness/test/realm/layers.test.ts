import { closeSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EnvFile } from "../../src/realm/env-file";
import { EnvLayers } from "../../src/realm/layers";

describe("envLayers", () => {
  let selfDir: string;
  let projectDir: string;
  let globalDir: string;

  beforeEach(() => {
    const base = join(tmpdir(), `esm-layers-test-${Date.now()}`);
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

  it("finds capabilities in project layer", () => {
    writeFileSync(
      join(projectDir, "env.js"),
      `// @capabilities [{"name":"shout","source":"(text) => text.toUpperCase()","meta":{}}]\n` +
        `// eta:generated\n\n` +
        `// eta:capability shout\n` +
        `eta.define("shout", (text) => text.toUpperCase(), {});\n` +
        `// eta:end\n\n` +
        `// eta:by hand\n`,
    );

    writeFileSync(
      join(selfDir, "env.js"),
      `// @capabilities []\n// eta:generated\n\n// eta:by hand\n`,
    );

    const layers = new EnvLayers({ self: selfDir, project: projectDir });
    const found = layers.find("shout");

    expect(found).toBeDefined();
    expect(found?.layer).toBe("project");
    expect(found?.source).toContain("toUpperCase");
  });

  it("finds capabilities in self layer", () => {
    writeFileSync(
      join(selfDir, "env.js"),
      `// @capabilities [{"name":"whisper","source":"(text) => text.toLowerCase()","meta":{}}]\n` +
        `// eta:generated\n\n` +
        `// eta:capability whisper\n` +
        `eta.define("whisper", (text) => text.toLowerCase(), {});\n` +
        `// eta:end\n\n` +
        `// eta:by hand\n`,
    );

    const layers = new EnvLayers({ self: selfDir });
    const found = layers.find("whisper");

    expect(found).toBeDefined();
    expect(found?.layer).toBe("self");
    expect(found?.source).toContain("toLowerCase");
  });

  it("self layer overrides project layer for same name", () => {
    // Project 层有 shout
    writeFileSync(
      join(projectDir, "env.js"),
      `// @capabilities [{"name":"shout","source":"(text) => text.toUpperCase()","meta":{}}]\n` +
        `// eta:generated\n\n` +
        `// eta:capability shout\n` +
        `eta.define("shout", (text) => text.toUpperCase(), {});\n` +
        `// eta:end\n\n` +
        `// eta:by hand\n`,
    );

    // Self 层也有 shout（不同实现）
    writeFileSync(
      join(selfDir, "env.js"),
      `// @capabilities [{"name":"shout","source":"(text) => \\"OVERRIDE: \\" + text","meta":{}}]\n` +
        `// eta:generated\n\n` +
        `// eta:capability shout\n` +
        `eta.define("shout", (text) => "OVERRIDE: " + text, {});\n` +
        `// eta:end\n\n` +
        `// eta:by hand\n`,
    );

    const layers = new EnvLayers({ self: selfDir, project: projectDir });
    const found = layers.find("shout");

    expect(found).toBeDefined();
    expect(found?.layer).toBe("self");
    expect(found?.source).toContain("OVERRIDE");
  });

  it("searches all three layers in order", () => {
    // Global 层有 globalCap
    writeFileSync(
      join(globalDir, "env.js"),
      `// @capabilities [{"name":"globalCap","source":"() => \\"global\\"","meta":{}}]\n` +
        `// eta:generated\n\n` +
        `// eta:capability globalCap\n` +
        `eta.define("globalCap", () => "global", {});\n` +
        `// eta:end\n\n` +
        `// eta:by hand\n`,
    );

    // Project 层有 projectCap
    writeFileSync(
      join(projectDir, "env.js"),
      `// @capabilities [{"name":"projectCap","source":"() => \\"project\\"","meta":{}}]\n` +
        `// eta:generated\n\n` +
        `// eta:capability projectCap\n` +
        `eta.define("projectCap", () => "project", {});\n` +
        `// eta:end\n\n` +
        `// eta:by hand\n`,
    );

    // Self 层有 selfCap
    writeFileSync(
      join(selfDir, "env.js"),
      `// @capabilities [{"name":"selfCap","source":"() => \\"self\\"","meta":{}}]\n` +
        `// eta:generated\n\n` +
        `// eta:capability selfCap\n` +
        `eta.define("selfCap", () => "self", {});\n` +
        `// eta:end\n\n` +
        `// eta:by hand\n`,
    );

    const layers = new EnvLayers({
      self: selfDir,
      project: projectDir,
      global: globalDir,
    });

    expect(layers.find("selfCap")?.layer).toBe("self");
    expect(layers.find("projectCap")?.layer).toBe("project");
    expect(layers.find("globalCap")?.layer).toBe("global");
    expect(layers.find("nonexistent")).toBeUndefined();
  });

  it("returns undefined when capability not found", () => {
    writeFileSync(
      join(selfDir, "env.js"),
      `// @capabilities []\n// eta:generated\n\n// eta:by hand\n`,
    );

    const layers = new EnvLayers({ self: selfDir });
    const found = layers.find("notHere");

    expect(found).toBeUndefined();
  });

  it("computes joint hash from all layers", () => {
    writeFileSync(
      join(selfDir, "env.js"),
      `// @capabilities []\n// eta:generated\n\n// eta:by hand\nconst a = 1;`,
    );
    writeFileSync(
      join(projectDir, "env.js"),
      `// @capabilities []\n// eta:generated\n\n// eta:by hand\nconst b = 2;`,
    );

    const layers = new EnvLayers({ self: selfDir, project: projectDir });
    const hash1 = layers.hash;

    // Modify self layer
    writeFileSync(
      join(selfDir, "env.js"),
      `// @capabilities []\n// eta:generated\n\n// eta:by hand\nconst a = 999;`,
    );
    layers.reload();
    const hash2 = layers.hash;

    expect(hash1).not.toBe(hash2);
  });

  describe("concurrent writes and locking", () => {
    it("two concurrent define to project layer, both succeed without overwriting", async () => {
      // Initialize project layer with empty env.js
      writeFileSync(
        join(projectDir, "env.js"),
        `// @capabilities []\n// eta:generated\n\n// eta:by hand\n`,
      );

      const envFile1 = new EnvFile(join(projectDir, "env.js"));
      const envFile2 = new EnvFile(join(projectDir, "env.js"));

      // Simulate two agents trying to define different capabilities concurrently
      const results = await Promise.allSettled([
        Promise.resolve().then(() =>
          envFile1.add("shout", "(text) => text.toUpperCase()", {
            desc: "Convert text to uppercase",
          }),
        ),
        Promise.resolve().then(() =>
          envFile2.add("whisper", "(text) => text.toLowerCase()", {
            desc: "Convert text to lowercase",
          }),
        ),
      ]);

      // Both should succeed
      expect(results[0]?.status).toBe("fulfilled");
      expect(results[1]?.status).toBe("fulfilled");

      // Reload to verify both capabilities exist
      const verifyFile = new EnvFile(join(projectDir, "env.js"));
      expect(verifyFile.has("shout")).toBe(true);
      expect(verifyFile.has("whisper")).toBe(true);

      const capabilities = verifyFile.capabilities;
      expect(capabilities).toHaveLength(2);
      expect(capabilities.map((c) => c.name).sort()).toEqual([
        "shout",
        "whisper",
      ]);
    });

    it("two concurrent define with same name, second one fails", async () => {
      writeFileSync(
        join(projectDir, "env.js"),
        `// @capabilities []\n// eta:generated\n\n// eta:by hand\n`,
      );

      const envFile1 = new EnvFile(join(projectDir, "env.js"));
      const envFile2 = new EnvFile(join(projectDir, "env.js"));

      // Both try to define the same capability
      const results = await Promise.allSettled([
        Promise.resolve().then(() =>
          envFile1.add("format", "(x) => x.toString()", {}),
        ),
        Promise.resolve().then(() =>
          envFile2.add("format", "(x) => JSON.stringify(x)", {}),
        ),
      ]);

      // One should succeed, one should fail
      const succeeded = results.filter((r) => r.status === "fulfilled");
      const failed = results.filter((r) => r.status === "rejected");

      expect(succeeded).toHaveLength(1);
      expect(failed).toHaveLength(1);

      // Verify the file has exactly one capability
      const verifyFile = new EnvFile(join(projectDir, "env.js"));
      expect(verifyFile.has("format")).toBe(true);
      expect(verifyFile.capabilities).toHaveLength(1);
    });

    it("lock timeout after 5 seconds", async () => {
      writeFileSync(
        join(projectDir, "env.js"),
        `// @capabilities []\n// eta:generated\n\n// eta:by hand\n`,
      );

      const lockPath = join(projectDir, "env.js.lock");

      // Create and hold the lock file
      const fd = openSync(lockPath, "w");
      closeSync(fd);

      const envFile = new EnvFile(join(projectDir, "env.js"));

      const start = Date.now();
      try {
        // This should timeout after ~5 seconds
        envFile.add("test", "() => 42", {});
        expect.fail("Should have thrown timeout error");
      } catch (err: any) {
        const elapsed = Date.now() - start;
        expect(err.message).toContain("Failed to acquire lock");
        // Should have waited approximately 5 seconds (50 retries * 100ms)
        expect(elapsed).toBeGreaterThan(4500); // Allow some slack
        expect(elapsed).toBeLessThan(6000); // But not too much
      } finally {
        // Clean up lock
        rmSync(lockPath, { force: true });
      }
    }, 10000); // Increase test timeout to 10 seconds

    it("reload picks up concurrent write from another agent", async () => {
      // Agent A's view
      writeFileSync(
        join(projectDir, "env.js"),
        `// @capabilities []\n// eta:generated\n\n// eta:by hand\n`,
      );

      const envFileA = new EnvFile(join(projectDir, "env.js"));

      // Agent A writes first capability
      envFileA.add("capA", "() => 'from A'", { desc: "Capability A" });
      expect(envFileA.has("capA")).toBe(true);
      expect(envFileA.has("capB")).toBe(false);

      // Agent B's view (fresh instance)
      const envFileB = new EnvFile(join(projectDir, "env.js"));

      // Agent B should see A's capability after loading
      expect(envFileB.has("capA")).toBe(true);

      // Agent B writes second capability
      envFileB.add("capB", "() => 'from B'", { desc: "Capability B" });

      // Agent A reloads and should now see B's capability
      expect(envFileA.has("capB")).toBe(false); // Before reload
      envFileA.reload();
      expect(envFileA.has("capB")).toBe(true); // After reload

      // Both capabilities should exist
      expect(envFileA.capabilities).toHaveLength(2);
      expect(envFileB.capabilities).toHaveLength(2);
    });

    it("write uses atomic rename to prevent partial reads", async () => {
      writeFileSync(
        join(projectDir, "env.js"),
        `// @capabilities []\n// eta:generated\n\n// eta:by hand\n`,
      );

      const envFile = new EnvFile(join(projectDir, "env.js"));

      // Add a capability (this uses atomic rename internally)
      envFile.add(
        "longFunc",
        `(x) => {\n  // A long function that would be problematic if read partially\n  const result = x * 2;\n  return result + 100;\n}`,
        { desc: "A longer function" },
      );

      // Reload from disk should work cleanly
      const verifyFile = new EnvFile(join(projectDir, "env.js"));
      expect(verifyFile.has("longFunc")).toBe(true);

      const cap = verifyFile.capability("longFunc");
      expect(cap?.source).toContain("x * 2");
      expect(cap?.source).toContain("result + 100");
    });
  });
});
