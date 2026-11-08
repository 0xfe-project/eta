/**
 * Installing the resident host, with a script in place of `eta-host`: the real
 * `install-service` would install a service on this machine.
 */
import { describe, expect, it } from "vitest";
import { installService } from "../../src/connection/install";
import { fakeInstaller } from "../support/fake-programs";
import { closedPort, testHost } from "../support/host";

function env(values: Record<string, string>): NodeJS.ProcessEnv {
  return { ...process.env, ...values };
}

describe("installService", () => {
  it("fails in the running step with the output when the command exits non-zero", async () => {
    const program = await fakeInstaller();
    const steps: string[] = [];
    const result = await installService({
      program,
      env: env({ FAKE_EXIT: "1", FAKE_ERR: "Access is denied." }),
      localUrl: `http://127.0.0.1:${await closedPort()}`,
      runMs: 30_000,
      upMs: 5_000,
      probeTimeoutMs: 1_500,
      onStep: (step) => steps.push(step),
    });
    expect(result).toMatchObject({ ok: false, step: "running" });
    expect(result.output).toContain("Access is denied.");
    expect(steps).toEqual([]);
  });

  it("fails in the running step when the command outlasts its time, keeping what it printed", async () => {
    const program = await fakeInstaller();
    const started = Date.now();
    const result = await installService({
      program,
      env: env({ FAKE_SLEEP_MS: "60000", FAKE_OUT: "still going" }),
      localUrl: `http://127.0.0.1:${await closedPort()}`,
      runMs: 1_500,
      upMs: 5_000,
      probeTimeoutMs: 1_500,
    });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result).toMatchObject({ ok: false, step: "running" });
    expect(result.output).toContain("still going");
  });

  it("succeeds when the service comes up partway through the wait", async () => {
    const program = await fakeInstaller();
    const port = await closedPort();
    const late = new Promise((resolve) => setTimeout(resolve, 1_200)).then(() =>
      testHost({ port }),
    );
    const result = await installService({
      program,
      env: env({}),
      localUrl: `http://127.0.0.1:${port}`,
      runMs: 30_000,
      // Starting the host is slow when every package's tests run at once.
      upMs: 30_000,
      probeTimeoutMs: 500,
    });
    await late;
    expect(result.ok).toBe(true);
  }, 60_000);
});
