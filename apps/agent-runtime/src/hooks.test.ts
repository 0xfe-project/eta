// The image's akhook rules (hooks/akhook.yml), as Codex runs them before
// every shell command. Locally they wait for akhook to be built (turbo run
// build --filter=@axp/akhook); in CI (CI set) a missing build fails.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
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

describe.skipIf(akhook === undefined)("the approval plugin", () => {
  // A command an ask rule holds back, and the request akhook left for it.
  function blocked() {
    const home = mkdtempSync(join(tmpdir(), "axp-approval-"));
    const config = join(home, "ask.yml");
    writeFileSync(
      config,
      "version: 1\nask_instruction: 'id={request_id}'\nrules:\n  - id: push\n    on: shell_exec\n    action: ask\n    checks: [{argv: [git, push]}]\n    message: 要推送。\n",
    );
    const env = {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, "config"),
      AKHOOK_ADDITIONAL_CONFIG_PATH: config,
      AKHOOK_STATE_DIR: join(home, "state"),
      AKHOOK_BIN: akhook!,
    };
    const hook = () => {
      const done = spawnSync(akhook!, ["codex", "hook", "pre_tool_use"], {
        input: JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "git push origin main" },
          cwd: home,
        }),
        encoding: "utf8",
        env,
      });
      return done.stdout.trim()
        ? JSON.parse(done.stdout).hookSpecificOutput
        : null;
    };
    const reason: string = hook().permissionDecisionReason;
    return { env, hook, requestId: reason.split("id=")[1]!.slice(0, 16) };
  }

  /** Calls request_approval as Codex does, answering its elicitation with action. */
  async function call(
    env: NodeJS.ProcessEnv,
    requestId: string,
    action: string,
  ) {
    const server = spawn("node", [join(root, "plugins/approval/server.mjs")], {
      env,
      stdio: ["pipe", "pipe", "inherit"],
    });
    const send = (message: object) =>
      server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    const asked: Record<string, unknown>[] = [];
    const result = new Promise<Record<string, unknown>>((resolve) => {
      createInterface({ input: server.stdout }).on("line", (line) => {
        const message = JSON.parse(line);
        if (message.method === "elicitation/create") {
          asked.push(message.params);
          send({
            id: message.id,
            result: { action, content: action === "accept" ? {} : null },
          });
        } else if (message.id === 2) {
          resolve(message.result);
        }
      });
    });
    send({
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: { elicitation: {} },
        clientInfo: { name: "test", version: "1" },
      },
    });
    send({ method: "notifications/initialized" });
    send({
      id: 2,
      method: "tools/call",
      params: {
        name: "request_approval",
        arguments: { request_id: requestId },
      },
    });
    const answer = await result;
    server.kill();
    return { text: (answer.content as { text: string }[])[0]!.text, asked };
  }

  test("accepting lets the command through once", async () => {
    const { env, hook, requestId } = blocked();
    const { text, asked } = await call(env, requestId, "accept");
    expect(text).toContain("用户同意了");
    expect(asked).toEqual([
      {
        message: "要推送。\n\ngit push origin main",
        requestedSchema: { type: "object", properties: {} },
      },
    ]);
    expect(hook()).toBeNull();
    expect(hook()).not.toBeNull();
  });

  test("declining keeps it blocked", async () => {
    const { env, hook, requestId } = blocked();
    const { text } = await call(env, requestId, "decline");
    expect(text).toContain("用户拒绝了");
    expect(hook()).not.toBeNull();
  });
});
