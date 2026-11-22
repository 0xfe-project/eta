/** The host as a program, asked to stop the moment it says it is ready. */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tempDir } from "./support/host";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const STOP_WHEN_READY = fileURLToPath(
  new URL("fixtures/stop-when-ready.ts", import.meta.url),
);

describe("eta-host stopped as soon as it is ready", () => {
  // Windows has no SIGTERM to send oneself; a stop there comes over the stop pipe.
  it.skipIf(process.platform === "win32")(
    "closes and exits 0 rather than dying of the signal",
    async () => {
      const home = await tempDir("eta-main-stop-");
      const child = spawn(
        process.execPath,
        [
          "--preload",
          STOP_WHEN_READY,
          MAIN,
          "--port",
          "0",
          "--no-llm",
          "--no-web",
        ],
        {
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            HOME: home,
            ETA_RELEASES_URL: "http://127.0.0.1:9/releases",
            ETA_TOKEN: "",
          },
        },
      );
      let output = "";
      child.stdout.on("data", (chunk: unknown) => (output += String(chunk)));
      child.stderr.on("data", (chunk: unknown) => (output += String(chunk)));
      const [code, signal] = await new Promise<
        [number | null, NodeJS.Signals | null]
      >((resolve) =>
        child.on("exit", (exitCode, exitSignal) =>
          resolve([exitCode, exitSignal]),
        ),
      );
      // It got as far as saying it was ready, so the stop came after that.
      expect(output).toContain('"port":');
      expect({ code, signal }).toEqual({ code: 0, signal: null });
    },
    60_000,
  );
});
