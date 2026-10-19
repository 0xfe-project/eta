import type { McpArgs, McpResults, McpServerView } from "@eta/client-contracts";
import { useListTarget, useWireMutation } from "@/queries/wire";

// MCP servers on the wire: the `mcp` target (one `list` section, every agent's servers) and its
// calls. Credentials never reach the page: a sign-in is an address to open and a redirect URL to
// hand back.

const TARGET = "mcp";

/** Every agent's servers, kept live. */
export function useMcpServers() {
  const { items, loaded, error } = useListTarget<McpServerView>(TARGET);
  return { servers: items, loaded, error };
}

/** Connect now; the reply says whether it worked and why not. */
export function useConnectMcp() {
  return useWireMutation<McpArgs["connect"], McpResults["connect"]>(
    TARGET,
    "connect",
    { timeoutMs: 60_000 },
  );
}

export function useReconnectMcp() {
  return useWireMutation<McpArgs["reconnect"], McpResults["reconnect"]>(
    TARGET,
    "reconnect",
    { timeoutMs: 60_000 },
  );
}

/** Start a sign-in; the reply is the address to open. */
export function useLoginMcp() {
  return useWireMutation<McpArgs["login"], McpResults["login"]>(
    TARGET,
    "login",
    { timeoutMs: 30_000 },
  );
}

export function useCompleteMcpLogin() {
  return useWireMutation<McpArgs["completeLogin"], McpResults["completeLogin"]>(
    TARGET,
    "completeLogin",
    { timeoutMs: 30_000 },
  );
}

export function useLogoutMcp() {
  return useWireMutation<McpArgs["logout"], McpResults["logout"]>(
    TARGET,
    "logout",
  );
}
