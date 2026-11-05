/**
 * What kind of thing an artifact's version is: the code that judges it when it is published and
 * answers for it when it is opened.
 *
 * A kind decides how content is shown and nothing about what it may do. The routes check the
 * capability or the share before a kind is asked, and seal whatever it answers in the sandbox
 * afterwards (`routes.ts`), so neither a kind nor a manifest can loosen that. The rules for what
 * may be stored at all (clean paths, limits) are checked before `prepare`, for every kind.
 */
import type { ArtifactViewer } from "@eta/client-contracts";
import type { SiteFile } from "../files";
import type { VersionRecord } from "../store";

/** One request for a page of a version, already allowed. */
interface ArtifactRequest {
  /** The request itself: its `Accept`, its method (a GET or a HEAD). */
  http: Request;
  /** The clean decoded path after `files/`: `""` for the root, `a/` for a directory. */
  path: string;
  /** A stored file of this version as a path on disk, or nothing for a name that leaves it. */
  file: (name: string) => string | undefined;
}

export interface ArtifactKind<Manifest = unknown> {
  id: string;
  /** At publishing: judge the files and the options, and say what the version stores. Refuses with an `ArtifactError`. */
  prepare: (files: readonly SiteFile[], options: unknown) => Manifest;
  /** The path after `files/` a version opens at. */
  entry: (manifest: Manifest) => string;
  /** At opening: how to answer one request. */
  respond: (
    request: ArtifactRequest,
    version: VersionRecord,
    manifest: Manifest,
  ) => Promise<Response>;
  /** How the app opens it. */
  viewer: ArtifactViewer;
}

/**
 * A kind as the registry holds it. A manifest is stored by the kind that wrote it and read only by
 * that kind, so forgetting its type here costs nothing.
 */
export const kind = <Manifest>(
  definition: ArtifactKind<Manifest>,
): ArtifactKind => definition as ArtifactKind;
