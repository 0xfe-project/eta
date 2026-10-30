import type {
  LlmAccounts,
  LlmArgs,
  LlmConnection,
  LlmConnectionState,
  LlmConnector,
  LlmLogin,
  LlmModel,
  LlmQuota,
} from "@eta/client-contracts";
import { useQuery } from "@tanstack/react-query";
import { getWire } from "@/lib/wire";
import { useTarget, useWireMutation, useWireState } from "@/queries/wire";

// The LLM gateway on the wire: the `llm` target, whose `accounts` section says who is connected
// and in what state, `models` the catalog the accounts unlock and `quota` the subscription
// windows the providers report. Logging in is a few calls (start, poll, submit a key, cancel).
// A host without the gateway (started with --no-llm, or whose CPA did not start) has no `llm`
// plugin, and everything here is then empty.

const TARGET = "llm";

/** States that need the user to do something. */
export const NEEDS_ACTION: ReadonlySet<LlmConnectionState> = new Set([
  "needs_login",
  "error",
]);

/** States whose account serves requests (a degraded one recovers by itself). */
export const USABLE: ReadonlySet<LlmConnectionState> = new Set([
  "active",
  "degraded",
]);

export interface Llm {
  /** Whether this host has a gateway at all. */
  mounted: boolean;
  /** False while the gateway is still loading its credentials. */
  ready: boolean;
  connectors: readonly LlmConnector[];
  connections: readonly LlmConnection[];
  models: readonly LlmModel[];
  quota: readonly LlmQuota[];
}

const NONE: never[] = [];

/** The gateway's accounts, models and quota, kept live. */
export function useLlm(): Llm {
  const mounted = useWireState((state) =>
    state.mounted.some(
      (plugin) => plugin.name === TARGET && plugin.error === undefined,
    ),
  );
  const sections = useTarget(mounted ? TARGET : undefined)?.sections;
  const accounts = sections?.accounts as LlmAccounts | undefined;
  return {
    mounted,
    ready: accounts?.ready === true,
    connectors: accounts?.connectors ?? NONE,
    connections: accounts?.connections ?? NONE,
    models: (sections?.models as LlmModel[] | undefined) ?? NONE,
    quota: (sections?.quota as LlmQuota[] | undefined) ?? NONE,
  };
}

/** Check every account against its provider now. */
export function useRefreshLlm() {
  return useWireMutation<LlmArgs["refresh"]>(TARGET, "refresh", {
    timeoutMs: 60_000,
  });
}

export function useStartLogin() {
  return useWireMutation<LlmArgs["loginStart"], { login: LlmLogin }>(
    TARGET,
    "loginStart",
  );
}

export function useCancelLogin() {
  return useWireMutation<LlmArgs["loginCancel"]>(TARGET, "loginCancel");
}

/** Give an API key to a login that takes one; the gateway checks it with the provider. */
export function useSubmitApiKey() {
  return useWireMutation<LlmArgs["loginSubmit"], { login: LlmLogin }>(
    TARGET,
    "loginSubmit",
    { timeoutMs: 60_000 },
  );
}

export function useSetEnabled() {
  return useWireMutation<LlmArgs["setEnabled"]>(TARGET, "setEnabled");
}

export function useRemoveConnection() {
  return useWireMutation<LlmArgs["remove"]>(TARGET, "remove");
}

/**
 * Follows a login until it finishes. A login is not part of the target's state, so this asks
 * every second and a half and stops when the attempt is no longer pending.
 */
export function useLoginPoll(id: string | undefined) {
  return useQuery({
    queryKey: ["wire", TARGET, "loginPoll", id],
    enabled: id !== undefined,
    queryFn: async () =>
      (await getWire().call<{ login: LlmLogin }>(TARGET, "loginPoll", { id }))
        .login,
    refetchInterval: (query) =>
      query.state.data && query.state.data.status !== "pending" ? false : 1500,
    refetchIntervalInBackground: true,
  });
}
