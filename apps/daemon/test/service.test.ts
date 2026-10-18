import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  fingerprintOf,
  groupFingerprint,
  loadIdentity,
  saveIdentity,
} from "../src/identity";
import { serviceDefinition } from "../src/service";

const command = { program: "/opt/eta daemon/eta-daemon", args: [] };

describe("the service definition", () => {
  it("is a systemd user unit on Linux that runs the daemon on its data directory", () => {
    const definition = serviceDefinition(
      command,
      "/home/u/.eta-daemon",
      "linux",
      "/home/u",
    );
    expect(definition.path).toBe(
      `/home/u/.config/systemd/user/${definition.name}.service`,
    );
    expect(definition.content).toContain(
      'ExecStart="/opt/eta daemon/eta-daemon" "run" "--data-dir" "/home/u/.eta-daemon"',
    );
    expect(definition.content).toContain("WantedBy=default.target");
  });

  it("is a launchd agent on macOS", () => {
    const definition = serviceDefinition(
      command,
      "/Users/u/.eta-daemon",
      "darwin",
      "/Users/u",
    );
    expect(definition.path).toBe(
      `/Users/u/Library/LaunchAgents/${definition.name}.plist`,
    );
    expect(definition.content).toContain("<string>run</string>");
    expect(definition.content).toContain("<key>RunAtLoad</key><true/>");
  });

  it("names one service per data directory", () => {
    const one = serviceDefinition(command, "/a", "linux", "/h");
    const two = serviceDefinition(command, "/b", "linux", "/h");
    expect(one.name).not.toBe(two.name);
  });

  it("has no Windows service: that is WSL", () => {
    expect(() => serviceDefinition(command, "/a", "win32")).toThrow(/WSL/);
  });
});

describe("the identity", () => {
  it("is private to the user and round-trips", async () => {
    const dir = await mkdtemp(join(tmpdir(), "eta-identity-"));
    try {
      const dataDir = join(dir, "d");
      expect(loadIdentity(dataDir)).toBeUndefined();
      saveIdentity(dataDir, { url: "http://p:1", machineId: "m", secret: "s" });
      expect(loadIdentity(dataDir)).toEqual({
        url: "http://p:1",
        machineId: "m",
        secret: "s",
      });
      expect((await stat(join(dataDir, "identity.json"))).mode & 0o777).toBe(
        0o600,
      );
      expect((await stat(dataDir)).mode & 0o777).toBe(0o700);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("shows a fingerprint in groups a person can compare", () => {
    const fingerprint = fingerprintOf("secret");
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(groupFingerprint(fingerprint).split(" ")).toHaveLength(8);
  });
});
