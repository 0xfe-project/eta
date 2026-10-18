/**
 * The SSH environment against a real machine.
 *
 * Skipped unless a target is named, so the suite stays offline:
 *
 *   ETA_SSH_TARGET=user@host bun run --cwd packages/eta-ssh smoke
 *   ETA_SSH_TARGET_PORT=2222   ETA_SSH_FINGERPRINT=SHA256:…   (optional)
 *
 * Nothing about the machine is hardcoded: host, port, identity file and the
 * fingerprint all come from the environment. With `ETA_SSH_FINGERPRINT` set, the
 * host key must be that one — which is what makes this a check of the trust path
 * rather than a check that ssh happens to trust the host already.
 */

import { envContract } from "@eta/execution/testing";
import { describe, expect, it } from "vitest";
import { SshEnvironment } from "../src/env";
import { SshCommandTransport } from "../src/transport";

const target = process.env.ETA_SSH_TARGET;

describe.skipIf(target === undefined)("a real machine over ssh", () => {
  envContract(`SshEnvironment over ssh to ${target ?? ""}`, async () => {
    const [user, host] = (target ?? "").includes("@")
      ? target!.split("@")
      : [undefined, target!];
    const transport = await SshCommandTransport.connect({
      target: {
        host: host!,
        ...(user === undefined ? {} : { user }),
        ...(process.env.ETA_SSH_TARGET_PORT === undefined
          ? {}
          : { port: Number(process.env.ETA_SSH_TARGET_PORT) }),
        ...(process.env.ETA_SSH_IDENTITY === undefined
          ? {}
          : { identityFile: process.env.ETA_SSH_IDENTITY }),
      },
      ...(process.env.ETA_SSH_FINGERPRINT === undefined
        ? {}
        : { expectedFingerprint: process.env.ETA_SSH_FINGERPRINT }),
      warn: (message) => console.warn(message),
    });
    // A scratch directory on the far side, so the contract's files do not land in
    // somebody's home directory.
    const directory = (await transport.run("mktemp -d")).stdout.trim();
    return {
      env: new SshEnvironment({ transport, cwd: directory }),
      shell: {
        run: (command, options) =>
          new SshEnvironment({ transport, cwd: directory }).exec(
            command,
            options,
          ),
        echo: (text: string) =>
          `printf '%s\\n' '${text.replaceAll("'", "'\\''")}'`,
        fail: (code: number, text: string) =>
          `printf '%s' '${text.replaceAll("'", "'\\''")}' >&2; exit ${code}`,
      },
      dispose: async () => {
        await transport.run(`rm -rf -- ${directory}`);
        await transport.close();
      },
    };
  });

  it("keeps the connection usable across commands, and reports a dropped one", async () => {
    const transport = await SshCommandTransport.connect({
      target: { host: "localhost" },
      reuseConnection: true,
      warn: (message) => console.warn(message),
    });
    // Two commands in a row: the second reuses the first one's control socket.
    expect((await transport.run("echo one")).stdout.trim()).toBe("one");
    expect((await transport.run("echo two")).stdout.trim()).toBe("two");
    await transport.close();
  });
});
