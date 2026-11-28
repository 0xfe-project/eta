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

  describe("concurrent writes and locking", () => {
    it("two writers defining one name: the second is refused", async () => {
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

    it("a multi-line ability round-trips through the file", async () => {
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
