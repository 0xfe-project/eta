import type {
  BundleArgs,
  BundleResults,
  BundleView,
} from "@eta/client-contracts";
import { useListTarget, useWireMutation, useWireState } from "@/queries/wire";

// Environment bundles on the wire: the `bundles` target (one `list` section) and its calls. A
// bundle's secret is written here and never comes back: the view only says whether it is set.

const TARGET = "bundles";

/** The bundles, kept live. `mounted` is false on a host that has none (the editor hides them). */
export function useBundles() {
  const mounted = useWireState((state) =>
    state.mounted.some(
      (plugin) => plugin.name === TARGET && plugin.error === undefined,
    ),
  );
  const { items, loaded, error } = useListTarget<BundleView>(TARGET);
  return { bundles: items, loaded, error, mounted };
}

/** Set the values sent; `null` clears one, the ones left out stay. */
export function useConfigureBundle() {
  return useWireMutation<BundleArgs["configure"], BundleResults["configure"]>(
    TARGET,
    "configure",
  );
}

export function useAddBundle() {
  return useWireMutation<BundleArgs["add"], BundleResults["add"]>(
    TARGET,
    "add",
    { timeoutMs: 120_000 },
  );
}

export function useRemoveBundle() {
  return useWireMutation<BundleArgs["remove"], BundleResults["remove"]>(
    TARGET,
    "remove",
  );
}

/** Fetch git sources again; the host resolves their branch or tag anew. */
export function useRefreshBundles() {
  return useWireMutation<BundleArgs["refresh"], BundleResults["refresh"]>(
    TARGET,
    "refresh",
    { timeoutMs: 120_000 },
  );
}

/** Look at the machines again for the commands bundles require. */
export function useRecheckBundles() {
  return useWireMutation<BundleArgs["recheck"], BundleResults["recheck"]>(
    TARGET,
    "recheck",
    { timeoutMs: 30_000 },
  );
}
