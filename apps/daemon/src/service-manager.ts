/** The kind of service this computer has, behind the one interface. */
import type { DetachedRunner, ServiceManager, ServiceUnit } from "./service";
import type { WindowsOptions } from "./service-windows";
import process from "node:process";
import { launchdManager, launchdRunner } from "./service-launchd";
import { systemdManager, systemdRunner } from "./service-systemd";
import { windowsManager, windowsRunner } from "./service-windows";

/** Without `windows`, a program with no Windows service of its own: the daemon. */
export function serviceManager(
  unit: ServiceUnit,
  windows?: WindowsOptions,
): ServiceManager {
  switch (process.platform) {
    case "darwin":
      return launchdManager(
        unit,
        undefined,
        undefined,
        windows === undefined ? [] : [windows.worker.name],
      );
    case "linux":
      return systemdManager(unit);
    case "win32":
      if (windows !== undefined) return windowsManager(unit, windows);
  }
  throw new Error(
    `no service support on ${process.platform}: only systemd (Linux), launchd (macOS) and, for the host, Windows services, so start it by hand`,
  );
}

export function detachedRunner(windows?: WindowsOptions): DetachedRunner {
  switch (process.platform) {
    case "darwin":
      return launchdRunner();
    case "linux":
      return systemdRunner();
    case "win32":
      if (windows !== undefined) return windowsRunner(windows);
  }
  throw new Error(`nothing to run a detached job on ${process.platform}`);
}
