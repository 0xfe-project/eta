import type { OpenSession } from "@eta/harness";

/**
 * The tools a Captain session is not offered, although other sessions are.
 *
 * The task board withholds them on purpose: it keeps its conversation tools away from Captain,
 * which reads and controls tasks through its own `captain_*` tools and never drafts one for an
 * agent.
 *
 * The names are listed here, beside that guard rather than inside it, because withholding
 * is only half of the decision. A session's journal pins the tools it was opened with, and the
 * runner refuses to run while that pin names a tool the host does not install
 * (`configured_tools_unavailable`). One data directory is opened by every build pointed at it —
 * including a build that knows nothing about Captain, which installs these very tools and widens
 * the pin — so a Captain-aware build has to narrow the pin back on the way in, or Captain never
 * runs again.
 */
export const CAPTAIN_WITHHELD_TOOL_NAMES = [
  "draft_task",
  "list_tasks",
  "get_task",
  "create_task",
  "update_task",
  "comment_task",
] as const;

const WITHHELD: ReadonlySet<string> = new Set(CAPTAIN_WITHHELD_TOOL_NAMES);

/** The pinned names Captain is not to have. */
function withheldCaptainTools(pinned: readonly string[]): string[] {
  return pinned.filter((name) => WITHHELD.has(name));
}

/**
 * Take those names off a Captain session's pinned toolset, and say which ones went.
 *
 * A pin that is already clean writes nothing, so this is silent on every open after the first one
 * that finds the stale names. Everything else in the pin stays: the other tools Captain chose are
 * not this function's business.
 */
export function repairCaptainToolPin(
  session: Pick<OpenSession, "kernel">,
): string[] {
  const pinned = session.kernel.config.read("activeToolNames");
  const dropped = withheldCaptainTools(pinned);
  if (dropped.length === 0) return [];
  session.kernel.config.update({
    activeToolNames: pinned.filter((name) => !WITHHELD.has(name)),
  });
  return dropped;
}
