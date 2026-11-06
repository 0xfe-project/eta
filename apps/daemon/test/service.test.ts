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
import {
  installedEnv,
  launchdArgv,
  serviceArgv,
  serviceDefinition,
} from "../src/service";

const command = { program: "/opt/eta daemon/eta-daemon", args: [] };

describe("the service definition", () => {
  it("is a systemd user unit on Linux that runs the daemon on its data directory", () => {
    const definition = serviceDefinition(command, "linux", "/home/u");
    expect(definition.path).toBe(
      `/home/u/.config/systemd/user/${definition.name}.service`,
    );
    // The directory is the user's HOME, not a path in the unit: one root, one way to say it.
    expect(definition.content).toContain(
      'ExecStart="/opt/eta daemon/eta-daemon" "run"',
    );
    expect(definition.content).not.toContain("--data-dir");
    expect(definition.content).toContain("WantedBy=default.target");
  });

  it("is a launchd agent on macOS", () => {
    const definition = serviceDefinition(command, "darwin", "/Users/u");
    expect(definition.path).toBe(
      `/Users/u/Library/LaunchAgents/${definition.name}.plist`,
    );
    expect(definition.content).toContain("<string>run</string>");
    expect(definition.content).toContain("<key>RunAtLoad</key><true/>");
  });

  it("has one name: one daemon per user, in one directory", () => {
    expect(serviceDefinition(command, "linux", "/h").name).toBe(
      "io.eta.daemon",
    );
  });

  it("starts with the PATH it was installed from, which a service manager would not give it", () => {
    const unit = {
      name: "io.eta.host",
      description: "eta host",
      args: [],
      env: installedEnv({ PATH: "/home/u/.local/bin:/usr/bin" }),
    };
    const host = { program: "/opt/eta/eta-host", args: ["--port", "8790"] };
    const linux = serviceDefinition(host, "linux", "/home/u", unit);
    expect(linux.path).toBe("/home/u/.config/systemd/user/io.eta.host.service");
    expect(linux.content).toContain("Description=eta host");
    expect(linux.content).toContain(
      'ExecStart="/opt/eta/eta-host" "--port" "8790"\nEnvironment="PATH=/home/u/.local/bin:/usr/bin"\n',
    );
    const mac = serviceDefinition(host, "darwin", "/Users/u", unit);
    expect(mac.content).toContain(
      "<key>EnvironmentVariables</key><dict><key>PATH</key><string>/home/u/.local/bin:/usr/bin</string></dict>",
    );
    expect(installedEnv({})).toEqual({});
    // What `bun run` put in front is the checkout's, and a directory named twice is one.
    expect(
      installedEnv({
        PATH: "/repo/node_modules/.bin:/home/node_modules/.bin:/usr/bin:/bin:/usr/bin",
      }),
    ).toEqual({ PATH: "/usr/bin:/bin" });
  });

  it("is a file for the service shell on Windows", () => {
    const host = {
      name: "io.eta.host",
      description: "eta host",
      args: [],
      env: { PATH: "C:\\bin;C:\\Git\\cmd" },
    };
    const { content, path } = serviceDefinition(
      { program: "C:\\eta\\eta-host.exe", args: ["--port", "8790"] },
      "win32",
      "/Users/u",
      host,
    );
    expect(path).toBe("/Users/u/.eta/service/io.eta.host.json");
    expect(JSON.parse(content)).toEqual({
      argv: ["C:\\eta\\eta-host.exe", "--port", "8790"],
      env: host.env,
      log: "/Users/u/.eta/service/io.eta.host.log",
      state: "/Users/u/.eta/service/io.eta.host.state.json",
      once: false,
    });
  });

  it("splits a PATH by what separates it on the computer it came from", () => {
    expect(
      installedEnv({ PATH: "C:\\repo\\node_modules\\.bin;C:\\bin" }, ";"),
    ).toEqual({ PATH: "C:\\bin" });
  });

  it("gives launchd as long to stop it as systemd has, and somewhere to write", () => {
    const { content } = serviceDefinition(command, "darwin", "/Users/u");
    expect(content).toContain("<key>ExitTimeOut</key><integer>90</integer>");
    expect(content).toContain(
      "<key>StandardOutPath</key><string>/Users/u/Library/Logs/eta/io.eta.daemon.log</string>",
    );
  });
});

describe("what a unit runs", () => {
  it("reads back the command it was written with", () => {
    const argv = [
      "/home/a b/eta-host",
      "--port",
      "8790",
      "--token-file",
      '/x/100%/"q"\\z',
    ];
    const definition = serviceDefinition(
      { program: argv[0] as string, args: argv.slice(1) },
      "linux",
      "/home/u",
      { name: "io.eta.host", description: "eta host", args: [] },
    );
    expect(serviceArgv(definition.content)).toEqual(argv);
  });

  it("reads a plist back the same way", () => {
    const argv = ["/Users/a b/eta-host", "--token-file", `/x/<&>"'`];
    const { content } = serviceDefinition(
      { program: argv[0] as string, args: argv.slice(1) },
      "darwin",
      "/Users/u",
      { name: "io.eta.host", description: "eta host", args: [] },
    );
    expect(launchdArgv(content)).toEqual(argv);
    expect(launchdArgv("<plist/>")).toBeUndefined();
  });

  it("reads a line written by hand, and says when there is none", () => {
    expect(serviceArgv("[Service]\nExecStart=/bin/x --y 1\n")).toEqual([
      "/bin/x",
      "--y",
      "1",
    ]);
    expect(serviceArgv("[Service]\n")).toBeUndefined();
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
