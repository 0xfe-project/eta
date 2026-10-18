import type { Bundle } from "@/api/control-plane.gen";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { controlPlane, unwrap } from "@/lib/api";

// The bundle manager (/api/v1/bundles), still on the old control plane's REST: the host has no
// bundles (`capabilities.bundles` is off), and this goes when the settings page does.

export type { Bundle };

/** The plugins bundles add; fixed per deploy. */
export function usePlugins() {
  return useQuery({
    queryKey: ["plugins"],
    queryFn: async ({ signal }) =>
      unwrap(controlPlane.GET("/api/v1/plugins", { signal })),
    staleTime: Infinity,
  });
}

const bundlesKey = ["bundles"] as const;

/** The bundles agents are built from: the built-in ones, then the user's. */
export function useBundles() {
  return useQuery({
    queryKey: bundlesKey,
    queryFn: async ({ signal }) =>
      unwrap(controlPlane.GET("/api/v1/bundles", { signal })),
  });
}

export type BundleDraft = Pick<
  Bundle,
  "name" | "description" | "script" | "plugins"
> & {
  // The service's Kubernetes objects; empty for none.
  manifests: string;
  usesModels: boolean;
  database: boolean;
};

export const bundleDraft = (bundle: Bundle): BundleDraft => ({
  name: bundle.name,
  description: bundle.description,
  script: bundle.script,
  plugins: bundle.plugins,
  manifests: bundle.service?.manifests ?? "",
  usesModels: bundle.service?.uses?.includes("llm") ?? false,
  database: bundle.service?.database ?? false,
});

export function useUpdateBundle() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (draft: BundleDraft) =>
      unwrap(
        controlPlane.PATCH("/api/v1/bundles/{name}", {
          params: { path: { name: draft.name } },
          body: {
            description: draft.description,
            script: draft.script,
            plugins: draft.plugins,
            service: {
              manifests: draft.manifests,
              uses: draft.usesModels ? ["llm"] : [],
              database: draft.database,
            },
          },
        }),
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: bundlesKey }),
  });
}

export function useDeleteBundle() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) =>
      unwrap(
        controlPlane.DELETE("/api/v1/bundles/{name}", {
          params: { path: { name } },
        }),
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: bundlesKey }),
  });
}
