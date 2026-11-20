import type { AgentRuntimeInfo } from "@eta/client-contracts";

/**
 * Why a runtime cannot be picked, in a few words. The probe's own words (a stack of oar's, often)
 * are the details under the field, not the option.
 */
export function runtimeReason(
  runtime: AgentRuntimeInfo,
): "unauthenticated" | "missing" | "timeout" | "failed" | undefined {
  if (runtime.status === "available") return undefined;
  if (runtime.status !== "error") return runtime.status;
  return /timed? ?out/i.test(runtime.detail ?? "") ? "timeout" : "failed";
}

/** What signs a runtime in, run in a terminal on its machine; eta never signs one in itself. */
export const LOGIN_COMMANDS: Partial<Record<AgentRuntimeInfo["id"], string>> = {
  claude: "claude",
  codex: "codex login",
};
