/**
 * Runtime detection: the Node adapter is offered where its built-ins exist (Node, or Bun and
 * Deno in Node-compatibility mode) and withheld everywhere else. Under the test runner
 * `isNode` is true, so the positive path is what is exercised here; the negative path is a
 * property of `std-env`, not of this package.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOrThrow } from "@eta/execution";
import { describe, expect, it } from "vitest";
import { createLocalEnvironment, supportsNodeExecution } from "../src/index";

describe("runtime detection", () => {
  it("offers a working local environment when the runtime has node built-ins", async () => {
    expect(supportsNodeExecution()).toBe(true);
    const cwd = await mkdtemp(join(tmpdir(), "eta-detect-"));
    const env = createLocalEnvironment(cwd);
    expect(env).toBeDefined();
    try {
      expect(
        getOrThrow(await env!.exec("pwd")).stdout.trim().length,
      ).toBeGreaterThan(0);
    } finally {
      await env!.cleanup();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
