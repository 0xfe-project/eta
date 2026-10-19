/**
 * Artifacts: static sites an agent publishes, as versioned and shareable pages.
 *
 * The `artifacts` target publishes the `list` of them (not eager). Publishing is not an action:
 * an agent does it with the `publish_artifact` tool of its session, which packs a directory
 * through the session's own execution environment. What a client can do is share a version
 * publicly, take the share back, delete an artifact, and ask for an address to preview a version.
 *
 * Pages are served by the host itself, outside the socket, and each address carries its own
 * capability (the host's token gate does not apply to them, because a sandboxed iframe sends no
 * cookie and a public share is meant for people who are not the user):
 *
 * - `/preview/<capability>/files/<path>`: the app's own sandboxed iframe. A capability comes from
 *   `artifacts.preview`, opens one version, and stops working after an hour, so it is asked for
 *   when a version is opened and not kept in state.
 * - `/share/<token>/`, `/share/<token>/files/<path>` and `/share/<token>/archive.zip`: the public
 *   page of one version, until it is unshared. A token is 256 random bits, and unsharing kills it
 *   for good (sharing again makes a new one).
 * - `/artifacts/<id>/<version>/archive.zip`: the ZIP, for the app, behind the normal access.
 *
 * Every page is served in a sandbox without `allow-same-origin`: it runs, but it cannot reach the
 * host's API, its cookies or anything else of the user's.
 */
import type { CallFrame } from "@eta/client-wire-proto";

export interface ArtifactVersionView {
  /** From 1, per artifact; a version never changes once published. */
  number: number;
  files: number;
  /** The files' total size. */
  bytes: number;
  /** The ZIP's size. */
  size: number;
  createdAt: number;
  /** The app's own download of the ZIP. */
  archiveUrl: string;
  /** The public page's address while the version is shared, else null. */
  shareUrl: string | null;
  sharedAt: number | null;
}

export interface ArtifactView {
  id: string;
  title: string;
  /** The only agent that may add a version. It may have been deleted since. */
  publisherAgentId: string | null;
  /** The task it was published for. */
  taskId: string | null;
  /** The conversation it came from. */
  conversationId: string | null;
  /** Newest first. */
  versions: ArtifactVersionView[];
  createdAt: number;
  /** When the newest version was published. */
  updatedAt: number;
}

export interface ArtifactListSections {
  list: ArtifactView[];
}

export const ARTIFACT_ACTIONS = [
  "share",
  "unshare",
  "delete",
  "preview",
] as const;
export type ArtifactAction = (typeof ARTIFACT_ACTIONS)[number];

export interface ArtifactArgs {
  /** Makes the version public, or returns its page when it already is. */
  share: { artifactId: string; version: number };
  /** Kills the version's public page for good. */
  unshare: { artifactId: string; version: number };
  /** Removes the artifact, every version of it and its files. */
  delete: { artifactId: string };
  /** An address for the app's sandboxed iframe to load the version from. */
  preview: { artifactId: string; version: number };
}
export interface ArtifactResults {
  share: { artifact: ArtifactView; url: string };
  unshare: { artifact: ArtifactView };
  delete: { artifactId: string };
  /** `url` opens `index.html`; every relative address of the page resolves under the same capability. */
  preview: { url: string; expiresAt: number };
}
export type ArtifactCall = {
  [A in ArtifactAction]: Omit<CallFrame, "target" | "action" | "args"> & {
    target: "artifacts";
    action: A;
    args: ArtifactArgs[A];
  };
}[ArtifactAction];
