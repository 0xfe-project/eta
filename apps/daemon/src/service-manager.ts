/** The kind of service this computer has, behind the one interface. */
import type { DetachedRunner, ServiceManager, ServiceUnit } from "./service";
import type { WindowsOptions } from "./service-windows";
import process from "node:process";
import { launchdManager, launchdRunner } from "./service-launchd";
import { systemdManager, systemdRunner } from "./service-systemd";

/**
 * The Windows side is loaded when it is used, not when this module is: it reaches `bun:ffi` and
 * `node:net`, and a host on Linux has no reason to have either. `import()` is what keeps the
 * two platforms from paying for each other.
 */
async function windows(): Promise<typeof import("./service-windows")> {
  return import("./service-windows");
}

/** Without `windows`, a program with no Windows service of its own: the daemon. */
export async function serviceManager(
  unit: ServiceUnit,
  windowsOptions?: WindowsOptions,
): Promise<ServiceManager> {
  switch (process.platform) {
    case "darwin":
      return launchdManager(
        unit,
        undefined,
        undefined,
        windowsOptions === undefined ? [] : [windowsOptions.worker.name],
      );
    case "linux":
      return systemdManager(unit);
    case "win32":
      if (windowsOptions !== undefined) {
        const { windowsManager } = await windows();
        return windowsManager(unit, windowsOptions);
      }
  }
  throw new Error(
    `no service support on ${process.platform}: only systemd (Linux), launchd (macOS) and, for the host, Windows services, so start it by hand`,
  );
}

export async function detachedRunner(
  windowsOptions?: WindowsOptions,
): Promise<DetachedRunner> {
  switch (process.platform) {
    case "darwin":
      return launchdRunner();
    case "linux":
      return systemdRunner();
    case "win32":
      if (windowsOptions !== undefined) {
        const { windowsRunner } = await windows();
        return windowsRunner(windowsOptions);
      }
  }
  throw new Error(`nothing to run a detached job on ${process.platform}`);
}
