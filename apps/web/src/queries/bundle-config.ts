import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { controlPlane, unwrap } from "@/lib/api";

// A built-in bundle's config (/api/v1/bundles/{name}/config): the values
// its bundle.json's schema asks for. Secrets go in and never come back:
// the state only says they are set.

const key = (name: string) => ["bundles", name, "config"] as const;

export function useBundleConfig(name: string) {
  return useQuery({
    queryKey: key(name),
    queryFn: async ({ signal }) =>
      unwrap(
        controlPlane.GET("/api/v1/bundles/{name}/config", {
          params: { path: { name } },
          signal,
        }),
      ),
  });
}

/** Sets the values sent; null clears one, the ones left out stay. */
export function useSetBundleConfig(name: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (values: Record<string, string | null>) =>
      unwrap(
        controlPlane.PATCH("/api/v1/bundles/{name}/config", {
          params: { path: { name } },
          body: { values },
        }),
      ),
    onSuccess: (state) => {
      queryClient.setQueryData(key(name), state);
      void queryClient.invalidateQueries({
        queryKey: ["bundles"],
        exact: true,
      });
    },
  });
}

export function useClearBundleConfig(name: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      unwrap(
        controlPlane.DELETE("/api/v1/bundles/{name}/config", {
          params: { path: { name } },
        }),
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key(name) }),
  });
}
