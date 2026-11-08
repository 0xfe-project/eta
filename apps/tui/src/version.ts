/**
 * Which build this TUI is.
 *
 * A build puts the version in with `--define ETA_TUI_VERSION=…`. Run from source there is no
 * build, and the TUI says `dev`, as the host does.
 */
declare const ETA_TUI_VERSION: string | undefined;

export const TUI_VERSION: string =
  typeof ETA_TUI_VERSION === "string" ? ETA_TUI_VERSION : "dev";
