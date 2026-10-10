// The agent's Codex thread: the one Codex last updated in the agent's
// workspace, resumed; before the first turn there is none (Codex keeps a
// thread only once it has one), so one is started. Threads sub-agents
// started name their parent and are never the agent's.

import type { Codex } from "./appserver.ts";

export interface ThreadSettings {
  workspace: string;
  model?: string;
  instructions: string;
}

/** Thrown when the agent's thread exists but cannot be resumed. */
export class ResumeFailed extends Error {}

export async function openThread(
  codex: Codex,
  s: ThreadSettings,
): Promise<{ threadId: string; resumed: boolean }> {
  const options = {
    cwd: s.workspace,
    model: s.model ?? null,
    developerInstructions: s.instructions || null,
  };
  const listed = await codex.request("thread/list", {
    cwd: s.workspace,
    sortKey: "updated_at",
    sortDirection: "desc",
    archived: false,
    limit: 50,
  });
  const thread = listed.data.find(
    (t) => t.parentThreadId === null && !t.ephemeral,
  );
  if (thread !== undefined) {
    try {
      await codex.request("thread/resume", {
        threadId: thread.id,
        excludeTurns: true,
        ...options,
      });
    } catch (error) {
      // Never replace a thread that cannot be resumed.
      throw new ResumeFailed(`${thread.id}: ${String(error)}`, {
        cause: error,
      });
    }
    return { threadId: thread.id, resumed: true };
  }
  const started = await codex.request("thread/start", options);
  return { threadId: started.thread.id, resumed: false };
}
