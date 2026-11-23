import { platform } from "nsh";
import { desktopHostLauncherPath } from "@eta/client-contracts/host-launcher";

/** The packaged host launcher as a path the OS can execute. */
export function packagedHostBootstrap(): string | undefined {
  return desktopHostLauncherPath(platform.os, import.meta.url);
}

/** Exported for the test: the rule without the bundle URL. */
export function launcherPath(
  bundleUrl: string,
  os: string,
): string | undefined {
  return desktopHostLauncherPath(os, bundleUrl);
}
