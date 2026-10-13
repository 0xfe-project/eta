import type { ArtifactVersion } from "@/api/control-plane.gen";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { controlPlane, unwrap } from "@/lib/api";

// Static sites agents publish (/api/v1/artifacts; apps/control-plane
// internal/artifacts). A version's preview_url works for an hour, so an
// artifact is read again whenever it is opened.

export type { ArtifactVersion };

const key = (id: string) => ["artifacts", id] as const;

export function useArtifact(id: string, enabled: boolean) {
  return useQuery({
    queryKey: key(id),
    queryFn: async ({ signal }) =>
      unwrap(
        controlPlane.GET("/api/v1/artifacts/{artifact_id}", {
          params: { path: { artifact_id: id } },
          signal,
        }),
      ),
    enabled,
    staleTime: 0,
    // Previews stay valid for an hour; read new addresses well before.
    refetchInterval: 30 * 60_000,
  });
}

/** Shares a version publicly, or revokes its link. */
export function useShareArtifact(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ version, share }: { version: number; share: boolean }) => {
      const params = { path: { artifact_id: id, number: version } };
      return share
        ? unwrap(
            controlPlane.PUT(
              "/api/v1/artifacts/{artifact_id}/versions/{number}/share",
              { params },
            ),
          )
        : unwrap(
            controlPlane.DELETE(
              "/api/v1/artifacts/{artifact_id}/versions/{number}/share",
              { params },
            ),
          );
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: key(id) }),
  });
}

/** Where a version's ZIP downloads from, as the user. */
export const archiveURL = (id: string, version: number) =>
  `/api/v1/artifacts/${id}/versions/${version}/archive`;
