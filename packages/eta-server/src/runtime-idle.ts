/**
 * When an idle external runtime's process is let go (#668).
 *
 * A session on Claude Code, Codex, OpenCode or an ACP agent keeps one runtime process up from its
 * first run until it closes, which for a conversation is until the host stops: dozens of them, a
 * few hundred MB each. Letting one go is what a restart does anyway, early and for one session:
 * the conversation is the runtime's, on its disk, and the next run resumes it (`SessionRuntime.
 * release`). Nobody is asked and nothing is shown: the next message takes a moment longer.
 *
 * Read from the environment, so it holds on a host and a daemon alike and no screen has to know.
 */
import process from "node:process";

export interface RuntimeIdlePolicy {
  /** A process idle this long is let go; `0` never lets one go for idleness. */
  idleMs: number;
  /** At most this many processes stay up, the least recently active let go first; `0` is no cap. */
  maxResident: number;
  /** How often the sessions are looked at. */
  everyMs: number;
}

/** Thirty minutes idle: past a prompt cache's life, so a resume costs nothing a wait would not. */
const DEFAULT_RUNTIME_IDLE_MINUTES = 30;

function count(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * `ETA_RUNTIME_IDLE_MINUTES` (default 30, `0` off) and `ETA_RUNTIME_MAX_RESIDENT` (default `0`, no
 * cap). Both `0` turns the sweep off.
 */
export function runtimeIdlePolicyFromEnv(
  env: Record<string, string | undefined> = process.env,
): RuntimeIdlePolicy {
  const minutes = count(
    env.ETA_RUNTIME_IDLE_MINUTES,
    DEFAULT_RUNTIME_IDLE_MINUTES,
  );
  const maxResident = Math.floor(count(env.ETA_RUNTIME_MAX_RESIDENT, 0));
  return {
    idleMs: Math.round(minutes * 60_000),
    maxResident,
    everyMs: 60_000,
  };
}
