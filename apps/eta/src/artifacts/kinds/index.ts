/**
 * The kinds of artifact this host knows. Adding one is a file here and a line in `KINDS`; the
 * service and the routes stay as they are.
 *
 * What is meant to fit, and is not built: a Vite single-page app is `site` with `fallback`, built
 * by the agent in its own environment, with no Node build in eta. A devjar-style React artifact is
 * a kind that stores source and whose `respond` returns a fixed shell page that compiles it in the
 * same sandbox: devjar's preview runs in its host's origin, so it cannot be embedded in eta's page,
 * and it needs esm.sh, so the network has to be confirmed first. If eta ever builds for an agent, a
 * version needs a `status` (building, ready, failed), added then. A full-stack app is a `respond`
 * that proxies to a process, but the process's lifetime, its isolation and an origin of its own
 * are new problems this model does not try to answer in advance.
 */
import type { ArtifactKind } from "./kind";
import { site } from "./site";

/** The kinds a service serves, by id. */
export type ArtifactKinds = ReadonlyMap<string, ArtifactKind>;

export const artifactKinds = (kinds: readonly ArtifactKind[]): ArtifactKinds =>
  new Map(kinds.map((kind) => [kind.id, kind]));

export const KINDS = artifactKinds([site]);

/** The kind of a version published without saying. */
export const DEFAULT_KIND = site.id;
