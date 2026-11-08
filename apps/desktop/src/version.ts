/**
 * The app's version, from one place.
 *
 * A build takes it from `ETA_DESKTOP_VERSION`, which `release-desktop.yml` sets from the
 * `desktop-v*` tag, or else from `package.json`. `electrobun.config.ts` puts it in the bundle's
 * `Resources/version.json`, and the running app reads it back from there (`Updater.localInfo`), so
 * nothing else in the source names a version.
 */
import process from "node:process";
import pkg from "../package.json" with { type: "json" };

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?$/i;

/** The version a build of the app gets; throws on one that is not a version. */
export function buildVersion(env: NodeJS.ProcessEnv = process.env): string {
  const given = env["ETA_DESKTOP_VERSION"]?.trim();
  const version = given === undefined || given === "" ? pkg.version : given;
  if (!VERSION.test(version))
    throw new Error(
      `not a version: ${version} (ETA_DESKTOP_VERSION or package.json), like 0.2.0 or 0.2.0-rc.1`,
    );
  return version;
}
