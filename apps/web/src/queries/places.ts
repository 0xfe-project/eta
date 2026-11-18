import type {
  CloneView,
  PlaceCapabilities,
  PlaceListing,
  PlaceResolved,
  PlacesArgs,
  PlaceSearchResult,
  PlacesResults,
  RecentPlace,
  ReposResult,
} from "@eta/client-contracts";
import { queryOptions } from "@tanstack/react-query";
import { getWire } from "@/lib/wire";
import { useTarget } from "@/queries/wire";

// A machine's directories (`places.*`), answered on that machine: the host passes each question to
// the machine it names. Everything about a path (`~`, drives, crumbs, how it is written) comes back
// from there, so nothing here takes a path apart.

const NONE: readonly never[] = [];

export function placesCall<A extends keyof PlacesArgs>(
  action: A,
  args: PlacesArgs[A],
  timeoutMs = 25_000,
): Promise<PlacesResults[A]> {
  return getWire().call<PlacesResults[A]>("places", action, args, {
    timeoutMs,
  });
}

/** Used lately and the projects, every machine's, most recent first; shared with every client. */
export function useRecentPlaces(): readonly RecentPlace[] {
  return (
    (useTarget("places")?.sections.recent as RecentPlace[] | undefined) ?? NONE
  );
}

/** The clones running, and the ones that ended a moment ago. */
export function useClones(): readonly CloneView[] {
  return (
    (useTarget("places")?.sections.clones as CloneView[] | undefined) ?? NONE
  );
}

/** What a machine can do: git, gh, making directories, where a clone goes. */
export const capabilitiesQuery = (machineId: string) =>
  queryOptions({
    queryKey: ["places", "capabilities", machineId],
    queryFn: (): Promise<PlaceCapabilities> =>
      placesCall("capabilities", { machineId }, 40_000),
    staleTime: 30_000,
    retry: false,
  });

export const listQuery = (machineId: string, path: string | null) =>
  queryOptions({
    queryKey: ["places", "list", machineId, path],
    queryFn: (): Promise<PlaceListing> =>
      placesCall("list", {
        machineId,
        ...(path === null ? {} : { path }),
      }),
    staleTime: 5_000,
    retry: false,
  });

export const searchQuery = (machineId: string, query: string) =>
  queryOptions({
    queryKey: ["places", "search", machineId, query],
    queryFn: (): Promise<PlaceSearchResult> =>
      placesCall("search", { machineId, query }),
    staleTime: 5_000,
    retry: false,
  });

export const reposQuery = (machineId: string, query: string) =>
  queryOptions({
    queryKey: ["places", "repos", machineId, query],
    queryFn: (): Promise<ReposResult> =>
      placesCall("repos", { machineId, query }, 40_000),
    staleTime: 30_000,
    retry: false,
  });

export const resolvePlace = (
  machineId: string,
  path: string,
): Promise<PlaceResolved> => placesCall("resolve", { machineId, path });
