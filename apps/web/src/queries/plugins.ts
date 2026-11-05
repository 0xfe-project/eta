import type {
  PluginArgs,
  PluginAuditView,
  PluginResults,
  PluginView,
} from "@eta/client-contracts";
import { useListTarget, useTarget, useWireMutation } from "@/queries/wire";

// Plugins on the wire: the `plugins` target and its calls. A secret is written here and never
// comes back: the view only says whether it is set.

const TARGET = "plugins";

const NO_AUDIT: readonly PluginAuditView[] = [];

/** The plugins, kept live. */
export function usePlugins() {
  const { items, loaded, error } = useListTarget<PluginView>(TARGET);
  return { plugins: items, loaded, error };
}

/** The latest reads of a secret by an agent, newest first. */
export function usePluginAudit(): readonly PluginAuditView[] {
  const sections = useTarget(TARGET)?.sections as
    | { audit?: readonly PluginAuditView[] }
    | undefined;
  return sections?.audit ?? NO_AUDIT;
}

/** Set the values sent; `null` clears one, the ones left out stay. */
export function useConfigurePlugin() {
  return useWireMutation<PluginArgs["configure"], PluginResults["configure"]>(
    TARGET,
    "configure",
  );
}

export function useSetPluginLevel() {
  return useWireMutation<PluginArgs["setLevel"], PluginResults["setLevel"]>(
    TARGET,
    "setLevel",
  );
}

export function useAddPlugin() {
  return useWireMutation<PluginArgs["add"], PluginResults["add"]>(
    TARGET,
    "add",
    { timeoutMs: 120_000 },
  );
}

/** Fetch a git source again; the host resolves its branch or tag anew. */
export function useUpdatePlugin() {
  return useWireMutation<PluginArgs["update"], PluginResults["update"]>(
    TARGET,
    "update",
    { timeoutMs: 120_000 },
  );
}

export function useRemovePlugin() {
  return useWireMutation<PluginArgs["remove"], PluginResults["remove"]>(
    TARGET,
    "remove",
  );
}

/** Read the plugins again, and look at the machines for the commands they require. */
export function useRecheckPlugins() {
  return useWireMutation<PluginArgs["recheck"], PluginResults["recheck"]>(
    TARGET,
    "recheck",
    { timeoutMs: 30_000 },
  );
}
