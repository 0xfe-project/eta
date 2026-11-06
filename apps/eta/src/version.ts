/**
 * Which build this host is.
 *
 * `apps/desktop/scripts/stage-host.ts` puts the version and the commit in with `--define`; the
 * version is the one of the daemons it carries. Run from source there is no build, and the host
 * says `dev`, as the daemon does.
 */
declare const ETA_HOST_VERSION: string | undefined;
declare const ETA_HOST_COMMIT: string | undefined;

export const VERSION: string =
  typeof ETA_HOST_VERSION === "string" ? ETA_HOST_VERSION : "dev";

// A build outside a git checkout has no commit to name.
const COMMIT: string =
  typeof ETA_HOST_COMMIT === "string" ? ETA_HOST_COMMIT : "";

/** What `eta-host --version` prints: `eta-host 0.2.0 (37d8188c1234)`. */
export const VERSION_LINE =
  COMMIT === "" ? `eta-host ${VERSION}` : `eta-host ${VERSION} (${COMMIT})`;
