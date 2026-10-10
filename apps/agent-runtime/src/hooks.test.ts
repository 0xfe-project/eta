// The image's akhook rules (hooks/akhook.yml), as Codex runs them before
// every shell command. Locally they wait for akhook to be built (turbo run
// build --filter=@axp/akhook); in CI (CI set) a missing build fails.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { describe, expect, test } from "bun:test";

const root = resolve(import.meta.dir, "..");
const akhook = [
  process.env.AKHOOK,
  join(root, "../../packages/akhook/out/akhook"),
  join(root, "../../vendor/akhook/target/release/akhook"),
].find((path) => path && existsSync(path));

if (process.env.CI && akhook === undefined) {
  throw new Error(
    "CI: akhook is not built (turbo run build --filter=@axp/akhook)",
  );
}

function run(
  command: string,
): { permissionDecision: string; permissionDecisionReason: string } | null {
  const home = mkdtempSync(join(tmpdir(), "axp-hooks-"));
  const done = spawnSync(akhook!, ["codex", "hook", "pre_tool_use"], {
    input: JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command },
      cwd: home,
    }),
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, "config"),
      AKHOOK_ADDITIONAL_CONFIG_PATH: join(root, "hooks", "akhook.yml"),
      AKHOOK_STATE_DIR: join(home, "state"),
    },
  });
  expect(done.status).toBe(0);
  return done.stdout.trim() ? JSON.parse(done.stdout).hookSpecificOutput : null;
}

describe.skipIf(akhook === undefined)("the image's rules", () => {
  test.each([
    "git push origin main",
    "gh issue create -t x -b y",
    "gh api -X DELETE repos/a/b",
    "gh repo create a/b --private",
  ])("let %s through", (command) => {
    expect(run(command)).toBeNull();
  });

  test.each([
    ["gh pr create --fill", "gh-pr-create"],
    ["cd x && gh -R a/b pr create", "gh-pr-create"],
    ["akhook approval grant 0123456789abcdef", "akhook-approval"],
  ])("deny %s", (command, rule) => {
    const decision = run(command);
    expect(decision?.permissionDecision).toBe("deny");
    expect(decision?.permissionDecisionReason).toContain(`[${rule}]`);
  });
});
