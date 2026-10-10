// Which Codex thread is the agent's: the one Codex last wrote in the agent's
// workspace. Codex keeps every thread as a rollout file under
// CODEX_HOME/sessions whose first line describes it (session_meta); threads
// sub-agents started name their parent and are skipped.

import { Buffer } from "node:buffer";
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const ROLLOUT = /^rollout-.*\.jsonl$/;
// session_meta carries the thread's base instructions: long, but bounded.
const MAX_META_BYTES = 4 << 20;
const NEWLINE = "\n".charCodeAt(0);

async function firstLine(path: string): Promise<string> {
  const file = await open(path, "r");
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    const buffer = Buffer.alloc(64 << 10);
    while (size < MAX_META_BYTES) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, size);
      if (bytesRead === 0) {
        break;
      }
      const chunk = buffer.subarray(0, bytesRead);
      const end = chunk.indexOf(NEWLINE);
      chunks.push(Buffer.from(end === -1 ? chunk : chunk.subarray(0, end)));
      size += bytesRead;
      if (end !== -1) {
        break;
      }
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await file.close();
  }
}

/** The id of the agent's thread, or undefined before its first turn. */
export async function latestThread(
  codexHome: string,
  cwd: string,
): Promise<string | undefined> {
  const root = join(codexHome, "sessions");
  let names: string[];
  try {
    names = await readdir(root, { recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  const rollouts = await Promise.all(
    names
      .filter((name) => ROLLOUT.test(name.split("/").pop() ?? ""))
      .map(async (name) => ({
        path: join(root, name),
        modified: (await stat(join(root, name))).mtimeMs,
      })),
  );
  rollouts.sort((a, b) => b.modified - a.modified);
  for (const { path } of rollouts) {
    let meta: { type?: unknown; payload?: Record<string, unknown> };
    try {
      meta = JSON.parse(await firstLine(path)) as typeof meta;
    } catch {
      continue;
    }
    const thread = meta.payload;
    if (
      meta.type !== "session_meta" ||
      thread === undefined ||
      typeof thread.id !== "string"
    ) {
      continue;
    }
    const source = thread.source as Record<string, unknown> | undefined;
    if (
      thread.parent_thread_id ||
      (typeof source === "object" && source !== null && "subagent" in source)
    ) {
      continue;
    }
    if (thread.cwd === cwd) {
      return thread.id;
    }
  }
  return undefined;
}
