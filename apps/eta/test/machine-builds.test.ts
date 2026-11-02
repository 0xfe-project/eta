/**
 * Keeping machines at the primary's daemon build, finding them on the tailnet, and installing them.
 *
 * A real daemon (its node and link, in this process) against a real host, as in `machines.test.ts`;
 * the builds are a directory with a manifest, Tailscale is a scripted `tailscale` command and SSH a
 * scripted runner that plays the other computer.
 */
import type {
  DaemonServiceParams,
  MachineResults,
} from "@eta/client-contracts";
import type { SshRunner } from "../src/machines/install";
import type { TestDaemon } from "./support/daemon";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { DaemonLink, DaemonNode, enroll } from "@eta/daemon";
import { describe, expect, it } from "vitest";
import { platformOf } from "../src/machines/install";
import { Tailscale } from "../src/machines/tailscale";
import { until } from "./support/client";
import { approve, machineView, startDaemon } from "./support/daemon";
import { tempDir } from "./support/host";
import { world } from "./support/world";

const PLATFORM = `${process.platform}-${process.arch}`;
const BUILD = "#!/bin/sh\necho v2\n";
const sha256 = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

/** A directory of daemon builds at `version`, with one for this platform. */
async function builds(version = "v2"): Promise<string> {
  const dir = await tempDir("eta-builds-");
  await writeFile(join(dir, `eta-daemon-${PLATFORM}`), BUILD);
  await writeFile(
    join(dir, "manifest.json"),
    JSON.stringify({
      version,
      builds: {
        [PLATFORM]: {
          file: `eta-daemon-${PLATFORM}`,
          sha256: sha256(BUILD),
          size: BUILD.length,
        },
      },
    }),
  );
  return dir;
}

/** The daemon coming back after a restart: same identity, another build. */
async function restarted(daemon: TestDaemon, version: string) {
  await daemon.stop();
  const node = new DaemonNode({
    dataDir: daemon.dataDir,
    version,
    primaryUrl: daemon.identity.url,
    home: daemon.dataDir,
    akhookUserConfig: join(daemon.dataDir, "no-user-akhook.yml"),
    install: "service",
    warn: () => undefined,
  });
  await node.start();
  const link = new DaemonLink({
    identity: daemon.identity,
    server: node,
    backoff: { minMs: 20, maxMs: 100 },
    warn: () => undefined,
  });
  link.start();
  return {
    async stop() {
      await link.stop();
      await node.close();
    },
  };
}

describe("a daemon on another build", () => {
  it("is told to replace itself with the carried build, which it fetches with its credential", async () => {
    const w = await world({ daemonBuilds: await builds("v2") });
    const asked: DaemonServiceParams["upgrade"][] = [];
    let fetched: { status: number; body: string } | undefined;
    const daemon = await startDaemon(w.host, w.client, {
      node: {
        version: "v1",
        install: "service",
        upgrade: async (wanted) => {
          asked.push(wanted);
          const response = await fetch(
            `http://127.0.0.1:${w.host.port}/machines/daemon/${PLATFORM}`,
            {
              headers: {
                authorization: `Bearer ${daemon.identity.machineId}.${daemon.identity.secret}`,
              },
            },
          );
          fetched = { status: response.status, body: await response.text() };
          return { ok: true };
        },
      },
    });
    await w.client.call("machines", "approve", {
      machineId: daemon.machineId,
      fingerprint: daemon.fingerprint,
    });
    // `asked` fills before the fetch inside `upgrade` has answered.
    await until(() => fetched !== undefined, 10_000);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toEqual({ version: "v2", sha256: sha256(BUILD) });
    expect(fetched).toEqual({ status: 200, body: BUILD });
    // Not let in as the old build: it is being replaced.
    await until(
      () => machineView(w.client, daemon.machineId)?.build === "updating",
    );
    expect(machineView(w.client, daemon.machineId)?.status).not.toBe("online");

    const again = await restarted(daemon, "v2");
    await until(
      () =>
        machineView(w.client, daemon.machineId)?.status === "online" &&
        machineView(w.client, daemon.machineId)?.build === "current",
      10_000,
    );
    expect(machineView(w.client, daemon.machineId)).toMatchObject({
      version: "v2",
      platform: PLATFORM,
      install: "service",
      updateError: null,
    });
    await again.stop();
  });

  it("that comes back on the old build after swapping says the update did not hold", async () => {
    const w = await world({ daemonBuilds: await builds("v2") });
    let asked = 0;
    const daemon = await startDaemon(w.host, w.client, {
      node: {
        version: "v1",
        install: "service",
        upgrade: async () => {
          asked += 1;
          return { ok: true };
        },
      },
    });
    await w.client.call("machines", "approve", {
      machineId: daemon.machineId,
      fingerprint: daemon.fingerprint,
    });
    await until(() => asked === 1, 10_000);
    // The new build put the old one back: the same daemon, at v1 again.
    const again = await restarted(daemon, "v1");
    await until(
      () => machineView(w.client, daemon.machineId)?.status === "online",
      10_000,
    );
    expect(asked).toBe(1);
    expect(machineView(w.client, daemon.machineId)).toMatchObject({
      build: "outdated",
      updateError: "the update to v2 did not hold; it went back to v1",
    });
    await again.stop();
  });

  it("that cannot replace itself is let in as it is, with the reason on its row", async () => {
    const w = await world({ daemonBuilds: await builds("v2") });
    const daemon = await startDaemon(w.host, w.client, {
      node: { version: "v1", install: "binary" },
    });
    await approve(w.client, daemon);
    expect(machineView(w.client, daemon.machineId)).toMatchObject({
      build: "outdated",
      updateError: expect.stringMatching(/not run by a service/),
    });
  });

  it("is left alone by a primary that carries no builds", async () => {
    const w = await world();
    const daemon = await startDaemon(w.host, w.client, {
      node: { version: "v1", install: "service" },
    });
    await approve(w.client, daemon);
    expect(machineView(w.client, daemon.machineId)).toMatchObject({
      build: null,
      version: "v1",
      updateError: null,
    });
  });

  it("can be told again by hand, and the refusal is the call's error", async () => {
    const w = await world({ daemonBuilds: await builds("v2") });
    const daemon = await startDaemon(w.host, w.client, {
      node: {
        version: "v1",
        install: "service",
        upgrade: async () => ({ ok: false, reason: "disk full" }),
      },
    });
    await approve(w.client, daemon);
    expect(machineView(w.client, daemon.machineId)?.updateError).toBe(
      "disk full",
    );
    await expect(
      w.client.call("machines", "upgrade", { machineId: daemon.machineId }),
    ).rejects.toThrow(/disk full/);
  });
});

describe("the build route", () => {
  it("serves a machine that was let in, and nobody else", async () => {
    const w = await world({ daemonBuilds: await builds() });
    const daemon = await startDaemon(w.host, w.client);
    await approve(w.client, daemon);
    const url = `http://127.0.0.1:${w.host.port}/machines/daemon`;
    const auth = {
      authorization: `Bearer ${daemon.identity.machineId}.${daemon.identity.secret}`,
    };
    expect((await fetch(`${url}/${PLATFORM}`)).status).toBe(401);
    expect(
      (
        await fetch(`${url}/${PLATFORM}`, {
          headers: {
            authorization: `Bearer ${daemon.identity.machineId}.nope`,
          },
        })
      ).status,
    ).toBe(401);
    expect(
      await (await fetch(`${url}/${PLATFORM}`, { headers: auth })).text(),
    ).toBe(BUILD);
    expect((await fetch(`${url}/plan9-mips`, { headers: auth })).status).toBe(
      404,
    );
  });
});

/** A `tailscale` command that knows one tailnet: this node, a peer of the same user, a tagged one. */
function tailnet(whois: "own" | "tagged" | "stranger") {
  const status = {
    BackendState: "Running",
    Self: {
      ID: "nSELF",
      HostName: "primary",
      DNSName: "primary.tail1234.ts.net.",
      TailscaleIPs: ["100.64.0.1"],
      OS: "linux",
      Online: true,
      UserID: 1,
    },
    Peer: {
      k1: {
        ID: "nLAPTOP",
        HostName: "laptop",
        DNSName: "laptop.tail1234.ts.net.",
        TailscaleIPs: ["100.64.0.2"],
        OS: "macOS",
        Online: true,
        UserID: 1,
      },
      k2: {
        ID: "nCI",
        HostName: "ci",
        DNSName: "ci.tail1234.ts.net.",
        TailscaleIPs: ["100.64.0.3"],
        OS: "linux",
        Online: false,
        UserID: 2,
        Tags: ["tag:ci"],
      },
    },
    User: {
      1: { LoginName: "me@example.com" },
      2: { LoginName: "tagged-devices" },
    },
  };
  const who = {
    own: {
      Node: { StableID: "nLAPTOP", Name: "laptop.tail1234.ts.net." },
      UserProfile: { LoginName: "me@example.com" },
    },
    tagged: {
      Node: { StableID: "nCI", Name: "ci.", Tags: ["tag:ci"] },
      UserProfile: { LoginName: "tagged-devices" },
    },
    stranger: {
      Node: { StableID: "nX", Name: "x." },
      UserProfile: { LoginName: "them@example.com" },
    },
  }[whois];
  return new Tailscale({
    run: async (args) => {
      if (args[0] === "status") return JSON.stringify(status);
      if (args[0] === "whois") return JSON.stringify(who);
      if (args[0] === "ip") return "100.64.0.1\n";
      throw new Error(`unexpected tailscale ${args.join(" ")}`);
    },
  });
}

describe("the tailnet", () => {
  it("lets the user's own node in without a fingerprint, and remembers which node it is", async () => {
    const w = await world({ tailscale: tailnet("own") });
    const daemon = await startDaemon(w.host, w.client);
    await daemon.reached("online");
    await until(
      () => machineView(w.client, daemon.machineId)?.status === "online",
    );
    expect(machineView(w.client, daemon.machineId)?.tailnetNode).toBe(
      "nLAPTOP",
    );
  });

  it("asks for the fingerprint of a tagged node, and of another user's", async () => {
    for (const who of ["tagged", "stranger"] as const) {
      const w = await world({ tailscale: tailnet(who) });
      const daemon = await startDaemon(w.host, w.client);
      await daemon.reached("pending");
      expect(machineView(w.client, daemon.machineId)?.status).toBe("pending");
      await daemon.stop();
    }
  });

  it("discovery lists the nodes, whose they are, and which are machines here already", async () => {
    const w = await world({ tailscale: tailnet("own") });
    const daemon = await startDaemon(w.host, w.client);
    await until(
      () => machineView(w.client, daemon.machineId)?.status === "online",
    );
    const found = (await w.client.call(
      "machines",
      "discover",
      {},
    )) as MachineResults["discover"];
    expect(found).toMatchObject({
      available: true,
      self: {
        name: "primary",
        dnsName: "primary.tail1234.ts.net",
        login: "me@example.com",
      },
    });
    expect(found.peers).toEqual([
      expect.objectContaining({
        name: "ci",
        own: false,
        login: null,
        online: false,
        machineId: null,
      }),
      expect.objectContaining({
        name: "laptop",
        own: true,
        dnsName: "laptop.tail1234.ts.net",
        machineId: daemon.machineId,
      }),
    ]);
  });

  it("without Tailscale there is nothing to discover, and it says why", async () => {
    const w = await world({
      tailscale: new Tailscale({
        run: async () => {
          throw new Error("no");
        },
      }),
    });
    expect(await w.client.call("machines", "discover", {})).toMatchObject({
      available: false,
      reason: expect.stringMatching(/not running/),
      peers: [],
    });
  });
});

describe("installing over SSH", () => {
  it("sends the build for the computer's platform, registers it and installs the service", async () => {
    const scripts: string[] = [];
    let sent: string | undefined;
    const remoteDir = await tempDir("eta-remote-daemon-");
    const ssh: SshRunner = async (host, script, input) => {
      expect(host).toBe("me@laptop");
      scripts.push(script);
      if (script.startsWith("uname")) {
        const [os, arch] = PLATFORM.split("-");
        return {
          code: 0,
          stdout: `${os === "darwin" ? "Darwin" : "Linux"}\n${arch === "arm64" ? "aarch64" : "x86_64"}\n`,
          stderr: "",
        };
      }
      if (input !== undefined) sent = await input.text();
      const setup = /setup '([^']+)' '([^']+)' --no-wait/.exec(script);
      // The other computer registering with the code it was given.
      if (setup !== null)
        await enroll({ dataDir: remoteDir, url: setup[1]!, code: setup[2]! });
      return { code: 0, stdout: "", stderr: "" };
    };
    const w = await world({ daemonBuilds: await builds(), ssh });
    const result = (await w.client.call("machines", "install", {
      host: "me@laptop",
      url: `http://127.0.0.1:${w.host.port}`,
    })) as MachineResults["install"];
    expect(result.platform).toBe(PLATFORM);
    expect(result.machine).toMatchObject({ name: "laptop", status: "pending" });
    expect(sent).toBe(BUILD);
    expect(scripts.some((script) => script.includes("install-service"))).toBe(
      true,
    );
  });

  it("says which step failed, and refuses what is not a host", async () => {
    const ssh: SshRunner = async () => ({
      code: 255,
      stdout: "",
      stderr: "ssh: connect to host laptop port 22: Connection refused",
    });
    const w = await world({ daemonBuilds: await builds(), ssh });
    await expect(
      w.client.call("machines", "install", { host: "laptop" }),
    ).rejects.toThrow(
      /Asking what the computer is on laptop failed .*Connection refused/,
    );
    await expect(
      w.client.call("machines", "install", { host: "-oProxyCommand=x" }),
    ).rejects.toThrow(/not a host/);
  });

  it("knows the platforms by uname", () => {
    expect(platformOf("Linux", "x86_64")).toBe("linux-x64");
    expect(platformOf("Darwin", "arm64")).toBe("darwin-arm64");
    expect(platformOf("Linux", "aarch64")).toBe("linux-arm64");
    expect(platformOf("FreeBSD", "amd64")).toBeUndefined();
  });
});
