import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HOST_WRAPPER } from "../host";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "eta-wrapper-"));
});
afterEach(async () => {
  await rm(dir, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  });
});

const until = async (ready: () => Promise<boolean>, ms = 10_000) => {
  const deadline = Date.now() + ms;
  while (!(await ready())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(20);
  }
};

describe("the host's wrapper", () => {
  it.skipIf(process.platform === "win32")(
    "passes the shell's signal on: the host must not outlive the shell",
    async () => {
      const wrapper = join(dir, "wrapper.ts");
      const fake = join(dir, "host.ts");
      const summary = join(dir, "summary");
      const gone = join(dir, "gone");
      await writeFile(wrapper, HOST_WRAPPER);
      await writeFile(
        fake,
        `process.on("SIGTERM", async () => {
           await Bun.write(${JSON.stringify(gone)}, "stopped");
           process.exit(0);
         });
         console.log(JSON.stringify({ port: 1 }));
         setInterval(() => {}, 1000);`,
      );
      const child = Bun.spawn(
        [process.execPath, wrapper, process.execPath, fake],
        {
          env: { ...process.env, ETA_DESKTOP_SUMMARY: summary },
          stdout: "ignore",
          stderr: "ignore",
        },
      );
      await until(() => Bun.file(summary).exists());
      child.kill("SIGTERM");
      await child.exited;
      await until(() => Bun.file(gone).exists());
      expect(await Bun.file(gone).text()).toBe("stopped");
    },
  );

  it("stops the host when the shell is gone without a word", async () => {
    const wrapper = join(dir, "wrapper.ts");
    const fake = join(dir, "host.ts");
    const shell = join(dir, "shell.ts");
    const summary = join(dir, "summary");
    const gone = join(dir, "gone");
    const wrapperPid = join(dir, "wrapper-pid");
    const stopPipe =
      process.platform === "win32"
        ? `\\\\.\\pipe\\eta-test-wrapper-${randomUUID()}`
        : undefined;
    await writeFile(wrapper, HOST_WRAPPER);
    await writeFile(
      fake,
      `const stopPipe = process.env.ETA_STOP_PIPE;
       if (stopPipe) {
         const net = require("node:net");
         const server = net.createServer((conn) => {
           conn.once("data", async () => {
             await Bun.write(${JSON.stringify(gone)}, "stopped");
             server.close();
             process.exit(0);
           });
         });
         server.listen(stopPipe, () => {
           console.log(JSON.stringify({ port: 1 }));
         });
       } else {
         process.on("SIGTERM", async () => {
           await Bun.write(${JSON.stringify(gone)}, "stopped");
           process.exit(0);
         });
         console.log(JSON.stringify({ port: 1 }));
       }
       setInterval(() => {}, 1000);`,
    );
    // Use Node's `spawn({ detached: true })` so Windows doesn't place wrapper+fake into
    // `outer`'s `KILL_ON_JOB_CLOSE` Job Object when `outer.kill("SIGKILL")` runs.
    await writeFile(
      shell,
      `import { spawn } from "node:child_process";
       const child = spawn(${JSON.stringify(process.execPath)}, ${JSON.stringify([wrapper, process.execPath, fake])}, {
         detached: true,
         stdio: "ignore",
         env: {
           ...process.env,
           ETA_DESKTOP_SUMMARY: ${JSON.stringify(summary)},
           ...(process.env.ETA_STOP_PIPE ? { ETA_STOP_PIPE: process.env.ETA_STOP_PIPE } : {}),
         },
       });
       child.unref();
       await Bun.write(${JSON.stringify(wrapperPid)}, String(child.pid));
       setInterval(() => {}, 1000);`,
    );
    const outer = spawn(process.execPath, [shell], {
      env: {
        ...process.env,
        ...(stopPipe ? { ETA_STOP_PIPE: stopPipe } : {}),
      },
      stdio: "ignore",
    });
    try {
      await until(() => Bun.file(summary).exists());
      outer.kill("SIGKILL");
      await new Promise<void>((resolve) => outer.once("exit", () => resolve()));
      await until(() => Bun.file(gone).exists(), 10_000);
      expect(await Bun.file(gone).text()).toBe("stopped");
    } finally {
      outer.kill("SIGKILL");
      const pidText = await Bun.file(wrapperPid)
        .text()
        .catch(() => "");
      const pid = Number(pidText);
      if (pid > 0) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Wrapper already exited once host stopped.
        }
      }
    }
  }, 20_000);
});
