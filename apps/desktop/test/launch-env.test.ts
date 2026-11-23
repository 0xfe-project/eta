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

/** The name to expect where one has to be filled in: the login name here, nothing off macOS. */
const filled = (): string | undefined =>
  process.platform === "darwin" ? account() : undefined;

/** The two names of an environment; `toEqual` ignores the ones it does not carry. */
const names = ({ USER, LOGNAME }: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
  USER,
  LOGNAME,
});

describe("the environment the desktop app starts its host with", () => {
  it("carries the user names macOS left out, and everything else as it was", () => {
    const { PATH, HOME, LANG } = launchEnvironment({
      PATH: "/usr/bin:/bin",
      HOME: "/Users/someone",
      LANG: "en_US.UTF-8",
    });
    expect(PATH).toBe("/usr/bin:/bin");
    expect(HOME).toBe("/Users/someone");
    expect(LANG).toBe("en_US.UTF-8");
    expect(names(launchEnvironment({ PATH: "/usr/bin:/bin" }))).toEqual({
      USER: filled(),
      LOGNAME: filled(),
    });
  });

  it("keeps the names a login shell already gave the app", () => {
    expect(launchEnvironment({ USER: "someone", LOGNAME: "someone" })).toEqual({
      USER: "someone",
      LOGNAME: "someone",
    });
  });

  it("fills only the one that is missing", () => {
    // The name that was there is the name that stays, whichever of the two it is.
    expect(names(launchEnvironment({ USER: "someone" }))).toEqual({
      USER: "someone",
      LOGNAME: filled(),
    });
    expect(names(launchEnvironment({ LOGNAME: "someone" }))).toEqual({
      USER: filled(),
      LOGNAME: "someone",
    });
  });

  it("counts an empty value as missing, which is what launchd hands over", () => {
    expect(names(launchEnvironment({ USER: "", LOGNAME: "" }))).toEqual({
      USER: filled(),
      LOGNAME: filled(),
    });
  });

  it("takes the login shell's PATH only when one was asked for", () => {
    const { PATH: asked } = launchEnvironment(
      { PATH: "/usr/bin:/bin" },
      "/opt/homebrew/bin:/usr/bin:/bin",
    );
    expect(asked).toBe("/opt/homebrew/bin:/usr/bin:/bin");
    // A dev run asks for no path, and an inherited one is passed on as it is.
    const { PATH: inherited } = launchEnvironment({ PATH: "/usr/bin:/bin" });
    expect(inherited).toBe("/usr/bin:/bin");
  });

  it("changes nothing at all off macOS", () => {
    const original = Object.getOwnPropertyDescriptor(process, "platform");
    try {
      Object.defineProperty(process, "platform", { value: "linux" });
      expect(launchEnvironment({ PATH: "/usr/bin:/bin" })).toEqual({
        PATH: "/usr/bin:/bin",
      });
      expect(launchEnvironment({ USER: "", LOGNAME: "" })).toEqual({
        USER: "",
        LOGNAME: "",
      });
    } finally {
      Object.defineProperty(
        process,
        "platform",
        original as PropertyDescriptor,
      );
    }
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
      const { HOME, PATH: hostPath } = started;
      expect(HOME).toBe(dir);
      expect(hostPath).toBe("/usr/bin:/bin");
      expect(names(started)).toEqual({ USER: filled(), LOGNAME: filled() });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
