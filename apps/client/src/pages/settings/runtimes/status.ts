import type { AgentResults, AgentRuntimeInfo } from "@eta/client-contracts";
import type { useHost } from "../../../services/host";

/** Why a runtime cannot be picked, in a few words. */
export type RuntimeReason =
  | "unauthenticated"
  | "missing"
  | "timeout"
  | "failed";

/**
 * Why a runtime cannot be picked, or undefined when it can. The probe's own words (a stack of
 * oar's, often) are the details under the field, never the option: an `error` whose words say it
 * timed out is a timeout (a runtime gets 30s to list its models), any other one a failure.
 */
export function runtimeReason(
  runtime: AgentRuntimeInfo,
): RuntimeReason | undefined {
  if (runtime.status === "available") return undefined;
  if (runtime.status !== "error") return runtime.status;
  return /timed? ?out/i.test(runtime.detail ?? "") ? "timeout" : "failed";
}

/** The short reason as the picker and the Runtimes section say it. */
export const reasonText = {
  unauthenticated: "runtimeNotSignedIn",
  missing: "runtimeNotInstalled",
  timeout: "runtimeProbeTimedOut",
  failed: "runtimeProbeFailed",
} as const satisfies Record<RuntimeReason, string>;

/** Amber for what the user can fix on the machine, red for a probe that went wrong. */
export function reasonTone(reason: RuntimeReason | undefined) {
  return reason === undefined
    ? "green"
    : reason === "timeout" || reason === "failed"
      ? "red"
      : "warning";
}

/** What signs a runtime in, run in a terminal on its machine; eta never signs one in itself. */
export const LOGIN_COMMANDS: Partial<Record<string, string>> = {
  claude: "claude",
  codex: "codex login",
  antigravity: "agy acp --login",
  grok: "grok login",
};

/**
 * Past a runtime's own 30s: a client that gave up with it would call the whole machine
 * unreachable, and "timed out" would never be said.
 */
export const RUNTIMES_TIMEOUT_MS = 70_000;

/**
 * A machine's runtimes (`machineId` undefined or null is the primary). `fresh` asks them again
 * past the host's cache, which keeps a failed answer as long as a good one.
 */
export async function askRuntimes(
  host: ReturnType<typeof useHost>,
  machineId: string | null | undefined,
  fresh = false,
) {
  const result = await host.call<AgentResults["runtimes"]>(
    "agents",
    "runtimes",
    {
      ...(fresh ? { fresh: true } : {}),
      ...(machineId ? { machineId } : {}),
    },
    { timeoutMs: RUNTIMES_TIMEOUT_MS },
  );
  return result.runtimes;
}
