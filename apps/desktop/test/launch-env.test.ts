import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { launchEnvironment } from "../src/bun/launch-env";

/** The repository root, from this file's directory. */
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** The login name libc gives: what a host started without one should be handed. */
const account = (): string =>
  Bun.spawnSync(["/usr/bin/id", "-un"]).stdout.toString().trim();

/**
 * The environment `launchEnvironment` builds as if it were running on `platform`.
 *
 * Spelled out rather than left to the machine the tests happen to run on: macOS is where the names
 * go missing and every other platform is where they must be left alone, and both are worth checking
 * from either — a test that only asks the platform it runs on was green here and red on the Linux CI.
 */
const launch = (
  env: NodeJS.ProcessEnv,
  path?: string,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv => {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  try {
    Object.defineProperty(process, "platform", { value: platform });
    return launchEnvironment(env, path);
  } finally {
    Object.defineProperty(process, "platform", original as PropertyDescriptor);
  }
};

describe("the environment the desktop app starts its host with", () => {
  it("carries the user names macOS left out, and everything else as it was", () => {
    expect(
      launch(
        { PATH: "/usr/bin:/bin", HOME: "/Users/someone", LANG: "en_US.UTF-8" },
        undefined,
        "darwin",
      ),
    ).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/Users/someone",
      LANG: "en_US.UTF-8",
      USER: account(),
      LOGNAME: account(),
    });
  });

  it("keeps the names a login shell already gave the app", () => {
    expect(
      launch({ USER: "someone", LOGNAME: "someone" }, undefined, "darwin"),
    ).toEqual({ USER: "someone", LOGNAME: "someone" });
  });

  it("fills only the one that is missing", () => {
    // The name that was there is the name that stays, whichever of the two it is.
    expect(launch({ USER: "someone" }, undefined, "darwin")).toEqual({
      USER: "someone",
      LOGNAME: account(),
    });
    expect(launch({ LOGNAME: "someone" }, undefined, "darwin")).toEqual({
      USER: account(),
      LOGNAME: "someone",
    });
  });

  it("counts an empty value as missing, which is what launchd hands over", () => {
    expect(launch({ USER: "", LOGNAME: "" }, undefined, "darwin")).toEqual({
      USER: account(),
      LOGNAME: account(),
    });
  });

  it("leaves the environment alone where the names are never lost", () => {
    const inherited = { PATH: "/usr/bin:/bin", USER: "", LOGNAME: "" };
    expect(launch(inherited, undefined, "linux")).toEqual(inherited);
    expect(launch(inherited, undefined, "win32")).toEqual(inherited);
  });

  it("takes the login shell's PATH only when one was asked for", () => {
    const { PATH: asked } = launch(
      { PATH: "/usr/bin:/bin" },
      "/opt/homebrew/bin:/usr/bin:/bin",
    );
    expect(asked).toBe("/opt/homebrew/bin:/usr/bin:/bin");
    // A dev run asks for no path, and an inherited one is passed on as it is.
    const { PATH: inherited } = launch({ PATH: "/usr/bin:/bin" });
    expect(inherited).toBe("/usr/bin:/bin");
  });

  it("fills them in a process that has neither, the way the app is started", async () => {
    const dir = await mkdtemp(join(tmpdir(), "eta-launch-env-"));
    try {
      const script = join(dir, "ask.ts");
      const module = join(
        root,
        "apps",
        "desktop",
        "src",
        "bun",
        "launch-env.ts",
      );
      await writeFile(
        script,
        `import { launchEnvironment } from ${JSON.stringify(module)};
console.log(JSON.stringify(launchEnvironment({ HOME: process.env.HOME, PATH: "/usr/bin:/bin" })));
`,
      );
      // launchd's environment as far as this goes: no USER, no LOGNAME.
      const { PATH } = process.env;
      const child = Bun.spawnSync([process.execPath, script], {
        env: { HOME: dir, PATH },
        stdin: "ignore",
        stderr: "pipe",
      });
      expect(child.exitCode, child.stderr.toString()).toBe(0);
      const started = JSON.parse(child.stdout.toString()) as NodeJS.ProcessEnv;
      const { HOME, PATH: hostPath, USER, LOGNAME } = started;
      expect(HOME).toBe(dir);
      expect(hostPath).toBe("/usr/bin:/bin");
      // What this machine does: a name here, and nothing to invent anywhere else.
      if (process.platform !== "darwin") {
        expect(USER).toBeUndefined();
        expect(LOGNAME).toBeUndefined();
        return;
      }
      expect(USER).toBe(account());
      expect(LOGNAME).toBe(account());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
