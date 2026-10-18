import type {
  ArtifactArgs,
  ArtifactResults,
  ArtifactVersionView,
  ArtifactView,
} from "@eta/client-contracts";
import { useListTarget, useWireMutation } from "@/queries/wire";

// Static sites agents publish, on the wire: the `artifacts` target (a `list`, not eager) and the
// actions that share, unshare, delete and ask for an address to preview. Publishing is the
// agent's `publish_artifact` tool, not an action.

export type ArtifactVersion = ArtifactVersionView;

/** Every artifact, with its versions newest first. */
export function useArtifacts() {
  const { items, loaded, error } = useListTarget<ArtifactView>("artifacts");
  return { artifacts: items, loaded, error };
}

/**
 * An address to load a version from in a sandboxed frame. Asked for each time a version is opened
 * and never kept: the capability in it works for an hour and then does not.
 */
export function usePreview() {
  return useWireMutation<ArtifactArgs["preview"], ArtifactResults["preview"]>(
    "artifacts",
    "preview",
  );
}

/** Makes a version public (the same link while it stays shared). */
export function useShareArtifact() {
  return useWireMutation<ArtifactArgs["share"], ArtifactResults["share"]>(
    "artifacts",
    "share",
  );
}

/** Ends a version's public link for good. */
export function useUnshareArtifact() {
  return useWireMutation<ArtifactArgs["unshare"], ArtifactResults["unshare"]>(
    "artifacts",
    "unshare",
  );
}
