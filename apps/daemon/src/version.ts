/**
 * Which build this daemon is.
 *
 * The build script (`scripts/build.ts`) puts the version in with `--define`; the primary carries
 * the same builds and compares the one a daemon reports with its own to know whether to replace
 * it. Run from source there is no build, and the daemon says `dev`.
 */
declare const ETA_DAEMON_VERSION: string | undefined;

export const VERSION: string =
  typeof ETA_DAEMON_VERSION === "string" ? ETA_DAEMON_VERSION : "dev";
