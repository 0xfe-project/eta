/**
 * The version a build of `eta` carries: `ETA_TUI_VERSION`, else `ETA_DAEMON_VERSION` (the release
 * workflow sets it from the tag for every build), else `dev`. Blank values count as unset.
 */
export function buildVersion(env: NodeJS.ProcessEnv): string {
  return env.ETA_TUI_VERSION?.trim() || env.ETA_DAEMON_VERSION?.trim() || "dev";
}
