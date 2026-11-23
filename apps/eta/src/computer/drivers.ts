/**
 * The real isolated realms the host opens, one per `computer_open`.
 *
 * `ComputerService` can fall back to a synthetic driver so its own tests can run anywhere; a real
 * `computer_open` must never land there, because a synthetic realm shows a drawn placeholder and
 * pretends its actions worked. This factory is the only place a realm's driver is chosen, so what
 * a session is told about a realm matches what actually runs behind it.
 */
import type { ViewportSize } from "@eta/client-contracts";
import type { FileBrokerPolicy } from "@eta/computer";
import type { ComputerDriverFactory } from "./service";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BrowserRealmDriver,
  probeWindowsCapabilities,
  WindowsAppRealmDriver,
} from "@eta/computer";

export interface RealmDriverFactoryOptions {
  /** Where browser downloads land (inside the session's staging directory). */
  downloadPath?: string | undefined;
  /** Where a temporary browser profile is created, one per realm. */
  profileBaseDir?: string | undefined;
}

/**
 * Build the driver for one realm: an isolated headless browser, or a Windows app on whichever
 * tier this machine can offer (Child Session, else the non-active hidden desktop).
 */
export function createRealmDriverFactory(
  options: RealmDriverFactoryOptions = {},
): ComputerDriverFactory {
  return async (ctx) => {
    const viewport: ViewportSize = {
      width: ctx.viewport?.width ?? 1280,
      height: ctx.viewport?.height ?? 800,
      scaleFactor: ctx.viewport?.scaleFactor ?? 1,
    };

    if (ctx.kind === "browser") {
      return await BrowserRealmDriver.launch({
        initialUrl: ctx.target,
        viewport,
        fileBroker: ctx.fileBroker,
        ...(options.downloadPath === undefined
          ? {}
          : { downloadPath: options.downloadPath }),
        ...(options.profileBaseDir === undefined
          ? {}
          : { profileBaseDir: options.profileBaseDir }),
      });
    }

    // Materialize an inline script if provided (e.g. Blender `--python` workflow) into a staging
    // file so the agent never has to drive Notepad or a shell tool just to save a script.
    let effectiveArgs: readonly string[] | undefined = ctx.args;
    if (ctx.script !== undefined && ctx.script.content.trim() !== "") {
      const scriptDir =
        options.downloadPath !== undefined
          ? join(options.downloadPath, "..", "scripts")
          : join(tmpdir(), "eta-computer-scripts");
      mkdirSync(scriptDir, { recursive: true });
      const rawExt = ctx.script.extension?.trim() || ".py";
      const ext = rawExt.startsWith(".") ? rawExt : `.${rawExt}`;
      const scriptPath = join(
        scriptDir,
        `script-${randomUUID().slice(0, 8)}${ext}`,
      );
      writeFileSync(scriptPath, ctx.script.content, "utf8");
      const flag = ctx.script.flag?.trim() || "--python";
      effectiveArgs = [...(ctx.args ?? []), flag, scriptPath];
    }

    // An application realm launches lazily; start it here so a target that cannot open (a blocked
    // name, a packaged app that refuses a non-active desktop) fails `computer_open` itself with
    // the reason, instead of failing the first observation afterwards.
    const driver = createAppDriver(
      ctx.target,
      effectiveArgs,
      ctx.title,
      viewport,
      ctx.fileBroker,
      ctx.attachTo,
    );
    await driver.ensureStarted();
    return driver;
  };
}

function createAppDriver(
  target: string,
  args: readonly string[] | undefined,
  title: string | undefined,
  viewport: ViewportSize,
  fileBroker: FileBrokerPolicy,
  attachTo?: string | undefined,
): WindowsAppRealmDriver {
  const capabilities = probeWindowsCapabilities();
  if (
    capabilities.windowsChildSession === "unsupported_os" &&
    capabilities.windowsHiddenDesktop === "unsupported_os"
  ) {
    throw new Error(
      `computer_app_unsupported_os: an isolated desktop application realm needs Windows; this machine is ${capabilities.os}`,
    );
  }
  // The driver picks the tier itself: Child Session where the machine allows one, otherwise the
  // non-active hidden desktop.
  return new WindowsAppRealmDriver({
    target,
    ...(args === undefined || args.length === 0 ? {} : { args }),
    ...(title === undefined || title === "" ? {} : { title }),
    viewport,
    capabilities,
    fileBroker,
    ...(attachTo === undefined ? {} : { attachTo }),
  });
}
