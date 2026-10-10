import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { latestThread } from "./thread.ts";

let home: string;
const cwd = "/agent/workspace";

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "axp-thread-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function rollout(
  day: string,
  id: string,
  payload: Record<string, unknown>,
  modified: number,
): Promise<void> {
  const dir = join(home, "sessions", "2026", "10", day);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `rollout-2026-10-${day}T00-00-00-${id}.jsonl`);
  const meta = {
    timestamp: "",
    type: "session_meta",
    payload: { id, cwd, ...payload },
  };
  await writeFile(path, `${JSON.stringify(meta)}\n{"type":"event_msg"}\n`);
  await utimes(path, modified, modified);
}

test("no sessions yet: no thread", async () => {
  expect(await latestThread(home, cwd)).toBeUndefined();
});

test("the thread Codex last wrote in the workspace", async () => {
  await rollout("01", "old", {}, 1000);
  await rollout("02", "newer", {}, 3000);
  await rollout("03", "elsewhere", { cwd: "/tmp" }, 5000);
  await rollout(
    "04",
    "child",
    { parent_thread_id: "newer", source: { subagent: { other: "guardian" } } },
    6000,
  );
  expect(await latestThread(home, cwd)).toBe("newer");
});
