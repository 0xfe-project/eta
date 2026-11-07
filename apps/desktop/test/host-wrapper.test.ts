import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HOST_WRAPPER } from "../src/bun/host";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "eta-wrapper-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const until = async (ready: () => Promise<boolean>) => {
  const deadline = Date.now() + 5_000;
  while (!(await ready())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(20);
  }
};

describe("the host's wrapper", () => {
  it("passes the shell's signal on: the host must not outlive the shell", async () => {
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
  });
});
