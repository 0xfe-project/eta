// The control plane owns (agent, group) -> Codex thread ids. Never discover
// a thread from the workspace: multiple groups share the same directory.

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
  threadId: string | null,
): Promise<{ threadId: string; resumed: boolean }> {
  const options = {
    cwd: s.workspace,
    model: s.model ?? null,
    developerInstructions: s.instructions || null,
  };
  if (threadId !== null) {
    try {
      await codex.request("thread/resume", {
        threadId,
        excludeTurns: true,
        ...options,
      });
    } catch (error) {
      // Never replace a thread that cannot be resumed.
      throw new ResumeFailed(`${threadId}: ${String(error)}`, {
        cause: error,
      });
    }
    return { threadId, resumed: true };
  }
  const started = await codex.request("thread/start", options);
  return { threadId: started.thread.id, resumed: false };
}
