import type { IncomingMessage, RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import type { NetworkInterfaceInfo } from "node:os";
import type { HttpsRequestFn } from "../src/machines/tailscale";
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";
import {
  buildTailscaleHttpsBaseUrl,
  DEFAULT_TAILSCALE_SERVE_PORT,
  isTailscaleInterface,
  isTailscaleIpv4Address,
  isTailscaleIpv6Address,
  parseTailscaleServeRootHolders,
  parseTailscaleServeRoutesTo,
  parseTailscaleStatus,
  probeHttpsEndpoint,
  stderrDiagnosticOf,
  Tailscale,
  TAILSCALE_PROBE_ATTEMPTS,
  TAILSCALE_PROBE_RETRY_DELAY_MS,
  TAILSCALE_PROBE_TIMEOUT_MS,
  tailscaleDiagnosticMessage,
  TailscaleError,
  tailscaleServeOffArgs,
} from "../src/machines/tailscale";

function assertCarriesNoSecret(error: object, secret: string): void {
  const seen = new WeakSet<object>();
  const walk = (value: unknown, path: string): void => {
    if (typeof value === "string") {
      expect(value, `${path} leaked stderr`).not.toContain(secret);
      return;
    }
    if (typeof value !== "object" || value === null || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((entry, index) => walk(entry, `${path}[${index}]`));
      return;
    }
    walk((value as { message?: unknown }).message, `${path}.message`);
    walk((value as { cause?: unknown }).cause, `${path}.cause`);
    for (const [key, nested] of Object.entries(value)) {
      walk(nested, `${path}.${key}`);
    }
  };
  walk(error, "error");
}

function makeInterfaceInfo(
  address: string,
  family: "IPv4" | "IPv6",
  internal = false,
): NetworkInterfaceInfo {
  return family === "IPv4"
    ? {
        address,
        netmask: "255.255.255.255",
        family: "IPv4",
        mac: "00:00:00:00:00:00",
        internal,
        cidr: `${address}/32`,
      }
    : {
        address,
        netmask: "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
        family: "IPv6",
        mac: "00:00:00:00:00:00",
        internal,
        cidr: `${address}/128`,
        scopeid: 0,
      };
}

describe("tailscale address and interface classification", () => {
  it("recognizes 100.64.0.0/10 as Tailscale IPv4 CGNAT addresses", () => {
    expect(isTailscaleIpv4Address("100.64.0.0")).toBe(true);
    expect(isTailscaleIpv4Address("100.100.100.100")).toBe(true);
    expect(isTailscaleIpv4Address("100.127.255.255")).toBe(true);
    expect(isTailscaleIpv4Address("100.63.255.255")).toBe(false);
    expect(isTailscaleIpv4Address("100.128.0.0")).toBe(false);
    expect(isTailscaleIpv4Address("192.168.1.20")).toBe(false);
    expect(isTailscaleIpv4Address("100.64.0.1abc")).toBe(false);
    expect(isTailscaleIpv4Address("100.64.0")).toBe(false);
  });

  it("recognizes fd7a:115c:a1e0::/48 as Tailscale IPv6 addresses", () => {
    expect(isTailscaleIpv6Address("fd7a:115c:a1e0::1")).toBe(true);
    expect(isTailscaleIpv6Address("FD7A:115C:A1E0:0:0:0:0:1")).toBe(true);
    expect(isTailscaleIpv6Address("[fd7a:115c:a1e0::ab12]")).toBe(true);
    expect(isTailscaleIpv6Address("fd7a:115c:a1e0::1%utun4")).toBe(true);
    expect(isTailscaleIpv6Address("fd7a:115c:a1e1::1")).toBe(false);
    expect(isTailscaleIpv6Address("fe80::1")).toBe(false);
    expect(isTailscaleIpv6Address("2001:db8::1")).toBe(false);
  });

  it("identifies Tailscale interfaces by name or IPv6 prefix, not CGNAT IPv4 alone", () => {
    expect(
      isTailscaleInterface("tailscale0", [
        makeInterfaceInfo("100.70.1.2", "IPv4"),
      ]),
    ).toBe(true);
    expect(
      isTailscaleInterface("utun4", [
        makeInterfaceInfo("100.101.102.103", "IPv4"),
        makeInterfaceInfo("fd7a:115c:a1e0::1", "IPv6"),
      ]),
    ).toBe(true);
    expect(
      isTailscaleInterface("CloudflareWARP", [
        makeInterfaceInfo("100.96.0.1", "IPv4"),
      ]),
    ).toBe(false);
    expect(
      isTailscaleInterface("utun7", [makeInterfaceInfo("100.85.0.1", "IPv4")]),
    ).toBe(false);
  });
});

describe("stderrDiagnosticOf and diagnostic hints", () => {
  it("classifies known CLI failures and masks unknown stderr", () => {
    expect(stderrDiagnosticOf("")).toBeUndefined();
    expect(stderrDiagnosticOf("   \n")).toBeUndefined();
    expect(stderrDiagnosticOf("error: handler does not exist")).toBe(
      "no-existing-handler",
    );
    expect(
      stderrDiagnosticOf("not logged in tskey-auth-secret-token-value"),
    ).toBe("not-logged-in");
    expect(stderrDiagnosticOf("Tailscale is stopped.")).toBe("not-running");
    expect(
      stderrDiagnosticOf(
        "tailscaled: the system cannot find the file specified",
      ),
    ).toBe("not-running");
    expect(
      stderrDiagnosticOf(
        "failed to connect to local tailscale\nconnect: connection refused",
      ),
    ).toBe("not-running");
    expect(stderrDiagnosticOf("Access denied: serve config denied")).toBe(
      "permission-denied",
    );
    expect(
      stderrDiagnosticOf(
        "Tailscale doesn't support connecting to remote destinations",
      ),
    ).toBe("unsupported-target");
    expect(stderrDiagnosticOf("some secret tskey-12345 failure")).toBe(
      "unknown",
    );
  });

  it("produces actionable hints for Linux operator, HTTPS admin, and occupied ports", () => {
    expect(
      tailscaleDiagnosticMessage("permission-denied", { platform: "linux" }),
    ).toContain("sudo tailscale set --operator=$USER");
    expect(
      tailscaleDiagnosticMessage("permission-denied", { platform: "darwin" }),
    ).not.toContain("sudo tailscale");
    expect(tailscaleDiagnosticMessage("https-disabled")).toContain(
      "https://login.tailscale.com/admin/dns",
    );
    expect(
      tailscaleDiagnosticMessage("port-occupied", { servePort: 443 }),
    ).toContain("8443");
    expect(
      tailscaleDiagnosticMessage("unsupported-target", {
        localHost: "192.168.1.5",
      }),
    ).toContain("192.168.1.5");
  });
});

describe("buildTailscaleHttpsBaseUrl", () => {
  it("omits default port 443 and includes non-default Serve ports", () => {
    expect(DEFAULT_TAILSCALE_SERVE_PORT).toBe(443);
    expect(
      buildTailscaleHttpsBaseUrl({ magicDnsName: "desktop.tail.ts.net." }),
    ).toBe("https://desktop.tail.ts.net");
    expect(
      buildTailscaleHttpsBaseUrl({
        magicDnsName: "desktop.tail.ts.net",
        servePort: 443,
      }),
    ).toBe("https://desktop.tail.ts.net");
    expect(
      buildTailscaleHttpsBaseUrl({
        magicDnsName: "desktop.tail.ts.net",
        servePort: 8443,
      }),
    ).toBe("https://desktop.tail.ts.net:8443");
  });
});

describe("parseTailscaleStatus and Tailscale.status", () => {
  it("parses status facts including CapMap.https and running state", () => {
    expect(
      parseTailscaleStatus(
        '{"Self":{"DNSName":"desktop.tail.ts.net.","TailscaleIPs":["100.100.100.100","fd7a:115c:a1e0::1","192.168.1.20"]}}',
      ),
    ).toEqual({
      running: null,
      backendState: null,
      magicDnsName: "desktop.tail.ts.net",
      tailnetIpv4Addresses: ["100.100.100.100"],
      httpsServeEnabled: null,
    });

    expect(
      parseTailscaleStatus(
        '{"BackendState":"Running","Self":{"CapMap":{"https":null,"funnel":null}}}',
      ),
    ).toMatchObject({
      running: true,
      backendState: "Running",
      httpsServeEnabled: true,
    });

    expect(
      parseTailscaleStatus(
        '{"BackendState":"Stopped","Self":{"CapMap":{"funnel":null}}}',
      ),
    ).toMatchObject({
      running: false,
      backendState: "Stopped",
      httpsServeEnabled: false,
    });

    expect(parseTailscaleStatus("not json")).toBeUndefined();
    expect(parseTailscaleStatus("[]")).toBeUndefined();
  });

  it("extends TailnetStatus with httpsServeEnabled and running while preserving existing behavior", async () => {
    const ts = new Tailscale({
      run: async (args) => {
        if (args[0] === "status") {
          return JSON.stringify({
            BackendState: "Running",
            Self: {
              ID: "nSELF",
              HostName: "primary",
              DNSName: "primary.tail1234.ts.net.",
              TailscaleIPs: ["100.64.0.1"],
              OS: "darwin",
              UserID: 1,
              CapMap: { https: null },
            },
            Peer: {
              k1: {
                ID: "nLAPTOP",
                HostName: "laptop",
                DNSName: "laptop.tail1234.ts.net.",
                TailscaleIPs: ["100.64.0.2"],
                OS: "linux",
                Online: true,
                UserID: 1,
              },
            },
            User: { 1: { LoginName: "me@example.com" } },
          });
        }
        if (args[0] === "whois") {
          const target = args[2];
          if (target === "100.64.0.2") {
            return JSON.stringify({
              Node: { StableID: "nLAPTOP", Name: "laptop.tail1234.ts.net." },
              UserProfile: { LoginName: "me@example.com" },
            });
          }
          return JSON.stringify({
            Node: { StableID: "nSELF", Name: "primary.tail1234.ts.net." },
            UserProfile: { LoginName: "me@example.com" },
          });
        }
        if (args[0] === "ip") return "100.64.0.1\n";
        throw new Error(`unexpected ${args.join(" ")}`);
      },
    });

    const status = await ts.status();
    expect(status).toMatchObject({
      running: true,
      httpsServeEnabled: true,
      self: {
        node: "nSELF",
        name: "primary",
        dnsName: "primary.tail1234.ts.net",
        login: "me@example.com",
        httpsServeEnabled: true,
      },
    });
    expect(await ts.address()).toBe("100.64.0.1");
    expect(await ts.ownNode("::ffff:100.64.0.2")).toEqual({ node: "nLAPTOP" });
    // Self node must never pass ownNode (local proxy protection).
    expect(await ts.ownNode("100.64.0.1")).toBeUndefined();
  });

  it("keeps nonzero exit diagnostics structured without leaking stderr secrets", async () => {
    const secret = "tskey-auth-secret-token-value";
    const ts = new Tailscale({
      run: async () => {
        throw Object.assign(new Error(`stderr: not logged in ${secret}`), {
          code: 7,
          stderr: `not logged in ${secret}`,
          stdout: "",
        });
      },
    });

    let caught: unknown;
    try {
      await ts.readStatus();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TailscaleError);
    const err = caught as TailscaleError;
    expect(err.code).toBe("exit");
    expect(err.subcommand).toBe("status");
    expect(err.exitCode).toBe(7);
    expect(err.stdoutLength).toBe(0);
    expect(err.stderrLength).toBe(`not logged in ${secret}`.length);
    expect(err.diagnostic).toBe("not-logged-in");
    expect(err.message).toBe("tailscale status exited with code 7.");
    assertCarriesNoSecret(err, secret);
  });
});

describe("parseTailscaleServeRoutesTo", () => {
  it("finds Serve routes that forward to the bound address, including Go proxy shorthands", () => {
    const status = JSON.stringify({
      TCP: {
        "443": { HTTPS: true },
        "7000": { TCPForward: "127.0.0.1:3773" },
        "7001": { TCPForward: "127.0.0.2:3773" },
        "80": { TCPForward: "unix:/run/app.sock" },
      },
      Web: {
        "box.tailnet.ts.net:443": {
          Handlers: {
            "/eta": { Proxy: "http://127.0.0.1:3773" },
            "/dashboard": { Proxy: "http://127.0.0.1:9000" },
          },
        },
        "box.tailnet.ts.net:8443": {
          Handlers: { "/": { Proxy: "http://127.0.0.1:5173" } },
        },
        "box.tailnet.ts.net:10000": {
          Handlers: {
            "/a": { Proxy: "http://127.0.0.2:3773" },
            "/b": { Proxy: "http://[::1]:3773" },
            "/c": { Proxy: "http://192.168.1.5:3773" },
            "/d": { Proxy: "http://0.0.0.0:3773" },
            "/e": { Proxy: "http://[::ffff:127.0.0.1]:3773" },
            "/f": { Proxy: "http://localhost:3773" },
            "/g": { Proxy: "3773" },
            "/h": { Proxy: "localhost:3773" },
            "/i": { Proxy: "http://[::]:3773" },
            "/j": { Proxy: "http://ip6-localhost:3773" },
            "/k": { Proxy: "http://box.1:3773" },
            "/l": { Proxy: "http://127.1:3773" },
            "/m": { Proxy: "unix:/run/app.sock" },
            "/n": { Proxy: "http://user:pass@127.0.0.1:3773" },
            "/o": { Proxy: "http://[0:0:0:0:0:ffff:7f00:1]:3773" },
            "/p": { Proxy: "http://127.0.0.1:03773" },
          },
        },
      },
      Services: {
        "svc:eta": {
          Web: {
            "eta.tailnet.ts.net:443": {
              Handlers: { "/": { Proxy: "http://127.0.0.1:3773" } },
            },
          },
        },
      },
      Foreground: {
        session1: { TCP: { "9000": { TCPForward: "localhost:3773" } } },
      },
    });

    expect(
      parseTailscaleServeRoutesTo(status, { host: "127.0.0.1", port: 3773 }),
    ).toEqual([
      { servePort: 7000 },
      { servePort: 443, mount: "/eta", host: "box.tailnet.ts.net" },
      ...(
        [
          ["/d", undefined],
          ["/e", undefined],
          ["/f", "localhost"],
          ["/g", undefined],
          ["/h", "localhost"],
          ["/i", "[::]"],
          ["/j", "ip6-localhost"],
          ["/k", "box.1"],
          ["/l", "127.1"],
          ["/n", undefined],
          ["/o", undefined],
          ["/p", undefined],
        ] as const
      ).map(([mount, ambiguous]) => ({
        servePort: 10000,
        mount,
        host: "box.tailnet.ts.net",
        ...(ambiguous === undefined ? {} : { ambiguous }),
      })),
      {
        servePort: 443,
        mount: "/",
        host: "eta.tailnet.ts.net",
        owner: "svc:eta",
      },
      { servePort: 9000, ambiguous: "localhost", owner: "foreground" },
    ]);

    expect(
      parseTailscaleServeRoutesTo(
        JSON.stringify({
          Web: {
            "box:443": { Handlers: { "/": { Proxy: "http://127.0.0.1" } } },
          },
        }),
        { host: "127.0.0.1", port: 80 },
      ),
    ).toEqual([{ servePort: 443, mount: "/", host: "box" }]);

    expect(
      parseTailscaleServeRoutesTo(
        JSON.stringify({
          Web: {
            "box:443": {
              Handlers: { "/": { Proxy: "https+insecure://127.0.0.1" } },
            },
          },
        }),
        { host: "127.0.0.1", port: 443 },
      ),
    ).toEqual([{ servePort: 443, mount: "/", host: "box" }]);

    expect(
      parseTailscaleServeRoutesTo("{}", { host: "127.0.0.1", port: 3773 }),
    ).toEqual([]);
    expect(
      parseTailscaleServeRoutesTo("null", { host: "127.0.0.1", port: 3773 }),
    ).toEqual([]);
    expect(
      parseTailscaleServeRoutesTo("not json", {
        host: "127.0.0.1",
        port: 3773,
      }),
    ).toBeUndefined();
    expect(
      parseTailscaleServeRoutesTo("[]", { host: "127.0.0.1", port: 3773 }),
    ).toBeUndefined();
  });
});

describe("parseTailscaleServeRootHolders and readServeRootHolder", () => {
  it("parses root holders across web, static, non-loopback, and TCP forwards", () => {
    const target = { host: "127.0.0.1", port: 3773 };
    const status = JSON.stringify({
      TCP: { "8443": { TCPForward: "127.0.0.1:22" } },
      Web: {
        "box.tailnet.ts.net:443": {
          Handlers: {
            "/": { Proxy: "http://127.0.0.1:3773" },
            "/x": { Proxy: "9000" },
          },
        },
        "old.tailnet.ts.net:443": {
          Handlers: { "/": { Proxy: "http://[::1]:4000" } },
        },
        "box.tailnet.ts.net:10000": {
          Handlers: { "/": { Proxy: "http://127.0.0.1:4001" } },
        },
        "box.tailnet.ts.net:10001": {
          Handlers: { "/": { Proxy: "http://10.0.0.5:4002" } },
        },
        "box.tailnet.ts.net:10002": {
          Handlers: { "/": { Text: "hi" } },
        },
      },
      Services: {
        "svc:eta": {
          Web: {
            "eta.tailnet.ts.net:10000": {
              Handlers: { "/": { Proxy: "4003" } },
            },
          },
        },
      },
    });

    expect(parseTailscaleServeRootHolders(status, 443, target)).toEqual([
      { ours: true },
      { ours: false, loopback: { host: "::1", port: 4000 } },
    ]);
    expect(parseTailscaleServeRootHolders(status, 10000, target)).toEqual([
      { ours: false, loopback: { host: "127.0.0.1", port: 4001 } },
    ]);
    expect(parseTailscaleServeRootHolders(status, 10001, target)).toEqual([
      { ours: false },
    ]);
    expect(parseTailscaleServeRootHolders(status, 10002, target)).toEqual([
      { ours: false },
    ]);
    expect(parseTailscaleServeRootHolders(status, 8443, target)).toEqual([
      { ours: false },
    ]);
    expect(parseTailscaleServeRootHolders("null", 443, target)).toEqual([]);
    expect(
      parseTailscaleServeRootHolders("not json", 443, target),
    ).toBeUndefined();
  });

  it("distinguishes none, ours, dead, and other live listeners", async () => {
    const target = { host: "127.0.0.1", port: 3773 };

    const noneTs = new Tailscale({ run: async () => "null" });
    expect(await noneTs.readServeRootHolder(443, target)).toBe("none");

    const oursTs = new Tailscale({
      run: async () =>
        JSON.stringify({
          Web: {
            "box.tail.ts.net:443": {
              Handlers: { "/": { Proxy: "http://127.0.0.1:3773" } },
            },
          },
        }),
    });
    expect(await oursTs.readServeRootHolder(443, target)).toBe("ours");

    // Start a real local TCP server to exercise the default TCP listener probe.
    const server = net.createServer();
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );
    const livePort = (server.address() as net.AddressInfo).port;
    try {
      const otherLiveTs = new Tailscale({
        run: async () =>
          JSON.stringify({
            Web: {
              "box.tail.ts.net:443": {
                Handlers: { "/": { Proxy: `http://127.0.0.1:${livePort}` } },
              },
            },
          }),
      });
      expect(await otherLiveTs.readServeRootHolder(443, target)).toBe("other");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    // After closing, the same port has no live listener -> "dead".
    const deadTs = new Tailscale({
      run: async () =>
        JSON.stringify({
          Web: {
            "box.tail.ts.net:443": {
              Handlers: { "/": { Proxy: `http://127.0.0.1:${livePort}` } },
            },
          },
        }),
    });
    expect(await deadTs.readServeRootHolder(443, target)).toBe("dead");

    // Static / non-loopback handler is always "other" without probing TCP.
    let probed = false;
    const staticTs = new Tailscale({
      run: async () =>
        JSON.stringify({
          Web: {
            "box.tail.ts.net:443": {
              Handlers: { "/": { Text: "another app" } },
            },
          },
        }),
      hasListener: async () => {
        probed = true;
        return false;
      },
    });
    expect(await staticTs.readServeRootHolder(443, target)).toBe("other");
    expect(probed).toBe(false);
  });
});

describe("ensureServe and disableServe", () => {
  it("fails fast without running serve when CapMap lacks https", async () => {
    const calls: string[][] = [];
    const ts = new Tailscale({
      run: async (args) => {
        calls.push(args);
        if (args[0] === "status") {
          return JSON.stringify({
            BackendState: "Running",
            Self: { DNSName: "desktop.tail.ts.net.", CapMap: {} },
          });
        }
        return "";
      },
    });

    await expect(ts.ensureServe({ localPort: 3773 })).rejects.toMatchObject({
      name: "TailscaleError",
      code: "https-disabled",
    });
    expect(calls).toEqual([["status", "--json"]]);
  });

  it("runs tailscale serve --bg with formatted local target when HTTPS is enabled or unknown", async () => {
    const calls: string[][] = [];
    const ts = new Tailscale({
      run: async (args) => {
        calls.push(args);
        if (args[0] === "status") {
          return JSON.stringify({
            BackendState: "Running",
            Self: {
              DNSName: "desktop.tail.ts.net.",
              CapMap: { https: null },
            },
          });
        }
        return "https://desktop.tail.ts.net/\n";
      },
    });

    await ts.ensureServe({ localPort: 4444 });
    await ts.ensureServe({
      localPort: 4444,
      servePort: 8443,
      localHost: "::1",
    });

    expect(calls).toEqual([
      ["status", "--json"],
      ["serve", "--bg", "--https=443", "http://127.0.0.1:4444"],
      ["status", "--json"],
      ["serve", "--bg", "--https=8443", "http://[::1]:4444"],
    ]);
  });

  it("always passes --set-path when disabling Serve so sibling routes are preserved", async () => {
    const calls: string[][] = [];
    const ts = new Tailscale({
      run: async (args) => {
        calls.push(args);
        return "";
      },
    });

    await ts.disableServe();
    await ts.disableServe({ servePort: 8443, mount: "/eta" });

    expect(calls).toEqual([
      ["serve", "--https=443", "--set-path=/", "off"],
      ["serve", "--https=8443", "--set-path=/eta", "off"],
    ]);

    expect(
      tailscaleServeOffArgs({
        servePort: 443,
        mount: "/",
        owner: "foreground",
      }),
    ).toBeUndefined();
    expect(
      tailscaleServeOffArgs({
        servePort: 443,
        mount: "/",
        owner: "svc:eta",
      }),
    ).toEqual([
      "serve",
      "--service=svc:eta",
      "--https=443",
      "--set-path=/",
      "off",
    ]);
    expect(tailscaleServeOffArgs({ servePort: 7000 })).toEqual([
      "serve",
      "--tcp=7000",
      "off",
    ]);
  });
});

// Test-only self-signed certs (SAN: box.tail1234.ts.net + localhost; mismatch SAN: wrong.tail1234.ts.net).
const VALID_PROBE_CERT = `-----BEGIN CERTIFICATE-----
MIIC7jCCAdagAwIBAgIJAOOxbdRJuzgFMA0GCSqGSIb3DQEBCwUAMB4xHDAaBgNV
BAMME2JveC50YWlsMTIzNC50cy5uZXQwIBcNMjYxMTI2MDE0NjI1WhgPMjEyNjEx
MDIwMTQ2MjVaMB4xHDAaBgNVBAMME2JveC50YWlsMTIzNC50cy5uZXQwggEiMA0G
CSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDko6BT1QuLYtQIt3hceU71cdblsZFa
ti4nUJ5zOmlhhor/8+dLF7Q1SYSo7nYVs+SyC5mlaTcv4X8/pH/TQHlKflz5QQsy
VeFgQ3EecLGY9kFmGs+6ElTjtlh6WwR57y4zyUb9oxuveb0TUkNBwNaaG/CQ5jKL
aivhLuhek9cpt3doT4IU2ZeG4Kxu5No3K4h8o/PUMO8h9iIIgSW8PjYLHukufYWh
0sytABDJRwABj1QXZwFvC9p/4kL98GMa4rVroVFJDTwB9GUE3N7cEawencYEKsFB
uv5I5dmWnYZB7v8ty/G9l4SENDSBOlOYC2uH4TJZR+PMSp+ur/bjhGWTAgMBAAGj
LTArMCkGA1UdEQQiMCCCE2JveC50YWlsMTIzNC50cy5uZXSCCWxvY2FsaG9zdDAN
BgkqhkiG9w0BAQsFAAOCAQEAk2TTTPdAI0hZoK1c76ew9/kU2TsxWHHcMmxHQqnb
aoGqfIsixT6Wu8Ryij8UhOroe9cbW0w/UPXxiN5Bp8ab7SNgsXU4I8qT5Eso9Syf
xdtOk0p7fEfzGXusLhiNxq+PrzfMJWaAwSNoZpwuyINZr2MadV/CaDFcyE12KboC
M4WVVts+wO33vMQZOG5s9Zk/ToqJed5BCK/K5M9GwDaaOsG6HxdRVrepc0vEGJX+
ZiSfEhq7rmuquYdV+DzuQHxkbtLh7mrYRy/VSREj6Q1t+W+u/d/vZ5wWOm+D46t6
jeSEB6d15Pp+8dibr+6uH8zxb5g0ShdhddFjB8yfGYs0mw==
-----END CERTIFICATE-----`;
const VALID_PROBE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQDko6BT1QuLYtQI
t3hceU71cdblsZFati4nUJ5zOmlhhor/8+dLF7Q1SYSo7nYVs+SyC5mlaTcv4X8/
pH/TQHlKflz5QQsyVeFgQ3EecLGY9kFmGs+6ElTjtlh6WwR57y4zyUb9oxuveb0T
UkNBwNaaG/CQ5jKLaivhLuhek9cpt3doT4IU2ZeG4Kxu5No3K4h8o/PUMO8h9iII
gSW8PjYLHukufYWh0sytABDJRwABj1QXZwFvC9p/4kL98GMa4rVroVFJDTwB9GUE
3N7cEawencYEKsFBuv5I5dmWnYZB7v8ty/G9l4SENDSBOlOYC2uH4TJZR+PMSp+u
r/bjhGWTAgMBAAECggEAGY4EVHpicPDZ3CONi2Bvp9VSfJfNNENag0BqhVyI/MKJ
9LOxLV534ODXt/33KtPRgujzAl7xMSPWEinzs4voQqA/CgjwFG8u4pCHKyzTXNJh
WuUyRIzZ+h2eZAaaSHqoQleD3MOHS6Sism8mX0oLcmwfBkMEcTqrrt6MUE3b5aiK
1aveCj1UZWUQF0grd4oPW93j93gTNVzgdsTi+3RZYuQimpUpsosEOdN+YSRu90uJ
JL1V6v5vekY9PRNbp3iKIlT1TGAQBRWUfFvMz05o9ODQhV8jTyLkaXsnnPZhcck9
qBxP0QxrlSpIol+Bnjj3RrCgtpBhPjbFyF8GFASr4QKBgQDz1oi6HVtjKNCEAXof
B8y1U+NaQxebMha7KZ7YOd/5Qv92rFJxwVZUPSOlWj/qq7nExbUzcL1fuDKW30Y/
5v/8EXbXcDmX+d1k9JIL/xLf//9QSTxc21Wma388hfwHrn1bF4sVGCgmcwUu2Z8t
eKFUR1K7ECbLeACKLZhrr5gusQKBgQDwCwY5KYbZgpqA1fmBfqac/bi+AX4qnLn6
TA1Dd46umgHUD3l1QSojnygTnr1EhpH9DHqq27rW4Vk53HNh1kBCxoEFql39QDJY
YaSi3/VRKN3yqmmQHIHOrYBMMHgrtN2v7Bswi7RVlswxod6ZtTgzkp6iF1viu2NI
PrItMGbRgwKBgDnipha4vWcu20FbMGiJa3lobsKQxtva6jaITOM76gW8d/TuN6w1
n47j7MBmSmIlXjZuUPPjQbGlgqz6WCz3Y7GtW68NPz7q3DoJLVqXtR1kInIm0KOi
lhSp1EzD6e7Q54Vmc2gQkgd+qq5Sj002I+ZkACnUTcFjvY0QAe0ehFwhAoGATEtU
uQpn3+5Q6S4ZVX1Ju5AxDcMvtJ+HxPQzKwRvBzPP7PTWJ9yEZjoJ5OKJSaRz9jfn
LTMVmYKad3eH/Mq6Nf8dtw1FPl8PIWQ3jcUdFaSllqFvV+yXnXcr1gt5xnqAE5A5
vB5LPQDm+cd3Fuewa0Pow6AlBlWE4st6mj5OD70CgYAgVaq7D9uRlDAclvR2XsVQ
xepqlGusdD7nHUMeZZYcsg2Qv6wDWrybvn/PxpXdJ4iddtBbHyLI9mNfRvA6yJ10
5sS0hF1oyW59ulh4dr4OTdKwC/GK46132bOC+rSuiGSSOkysbvrLS1OONZqcJr7J
R04X6aDhZj07+DVORaVZQg==
-----END PRIVATE KEY-----`;
const WRONG_PROBE_CERT = `-----BEGIN CERTIFICATE-----
MIIC6TCCAdGgAwIBAgIJAOCexUZTIMqlMA0GCSqGSIb3DQEBCwUAMCAxHjAcBgNV
BAMMFXdyb25nLnRhaWwxMjM0LnRzLm5ldDAgFw0yNjExMjYwMTQ2MjVaGA8yMTI2
MTEwMjAxNDYyNVowIDEeMBwGA1UEAwwVd3JvbmcudGFpbDEyMzQudHMubmV0MIIB
IjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA4N50vapv5okh3n9+h/G8mfj6
B4u3vwg9rgVbn44VzsoTPGMtC07jQMDTqRK+Mni/2wPkxgZjJvCQ558Bs1FHZcqC
JfM2yoX/A1A8V0Y7Lh8r09f9Y5R0RVfwRKjDcO7/Ht1LO5ZBCrtG+YP6G0MjBZF1
klETTSK1me86IoH4b3VaK3lJsVaMJ/Ik7e6epmBNT2wNjNj5qfv45jlEdj6pQSxz
Re+clwMsrlFzy9uUEcsbukb0/pvJ+5uvlI3b4fcxQbfkEN4rZw57EaSE2c3gGLca
FJKuV/EdPRRcGVs4EaVS1JMBcvg0M09+nv77d7pcHkEo38GRnlbabR1TSnqN9wID
AQABoyQwIjAgBgNVHREEGTAXghV3cm9uZy50YWlsMTIzNC50cy5uZXQwDQYJKoZI
hvcNAQELBQADggEBADcCNCHA3FWZjB09LMk4M0M9UqWxKLJPtXraSMFiu1eZ8MYI
Hsqkc6G7AJ/j3kT+OK3IcBavPEGQfAuM8KwhU1iv5Uih9CCXxDSfx+kugZKxcJjt
rNHeevjBvQqmglJXOxq2B/LPUDQ8etzOkJschum5Q2QDJoP2dGK4Ioy2fao+rOl2
S7z05p2jh4AOe2QHdOaoFhUlPx13eeSs01A2PqF4k6938EsJLuzHh82m2HidtAyc
P6zAcWY5Cest+irf2szM0UO6GrCP6hwG2ANSXyCzbG8BdtosCav1ETL8FYrSYCTb
7hh/yK+U04qABVrY1FwZhO0lHZSx7YGIOE31/pk=
-----END CERTIFICATE-----`;
const WRONG_PROBE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDg3nS9qm/miSHe
f36H8byZ+PoHi7e/CD2uBVufjhXOyhM8Yy0LTuNAwNOpEr4yeL/bA+TGBmMm8JDn
nwGzUUdlyoIl8zbKhf8DUDxXRjsuHyvT1/1jlHRFV/BEqMNw7v8e3Us7lkEKu0b5
g/obQyMFkXWSURNNIrWZ7zoigfhvdVoreUmxVown8iTt7p6mYE1PbA2M2Pmp+/jm
OUR2PqlBLHNF75yXAyyuUXPL25QRyxu6RvT+m8n7m6+Ujdvh9zFBt+QQ3itnDnsR
pITZzeAYtxoUkq5X8R09FFwZWzgRpVLUkwFy+DQzT36e/vt3ulweQSjfwZGeVtpt
HVNKeo33AgMBAAECggEAeJXSdIMZTr7q8q3b5Hq1cLwbGEDMYBzDNraY048WErY6
an+kgBPluaut1VS/ucEW4RPNcoOqWA9ZJVwXRVmot+VItaEfGKuSfOxh70syISGG
FywULXpGf4kQx0DYzY7cMGjrFyET7/VNsjAbxtLRzQKb0cK4Xvzl9Y5b1nVsDBgY
1pbxrGJvVJQLT7uGFPadGgTF9mT9R/t3uCf032QSjVxH8KhbeORIsoHr5CgDeic2
+4nIzdZB4UggXu/OWWUBIQgRt/socz/isamHRkwLkDbGbld7TNAolnkRyiBCIAiA
ddaq7/R4bDORwuld5fi06cLS1Ye+ZmQfy3C0drOygQKBgQDwZ8i2nFfZS1t6r12e
81/QlICy/0PcEC2509FERuaXSogWaCwQce860ohUeKmq/kfATma88DUzF9EBVf/4
DU2fz5qX3y0660OVW3u98DwIphkCny0sTqu1yv+/ru2jkoGmXRkxD+NQBhGU7dIh
QnWI4b5yIO/9F7TC/FyxC74u2QKBgQDvdKvLSu1dNI75PLXJNYCtF+luSPjL7AaK
r5M0K6p0yV8JJefSiAejI3G45HHmB7jYSJ062y8sIl0rt1snEh4ZTEkZnIf4IQ6C
wAkCtAyrtfdC888l0It4EFeRB2ea55s/2uYGLzi6NtP8D0QKLD8X3aQ/Gu6Sf/iz
YuEm0u1BTwKBgCH4uH89lphpMrMihttITvjdk1Y4BjHZw2xoB0Fbt4gXiyWHcPqd
7w1j5MnzBx7XsfH14kS+uPXQXsOOkI5P6vEzWAgwDGcwCavYcqMDiKg8OHqLXcnO
ECuvVPaUVJZxxIpqy32IXjnXsbJW7QOwLYW7SLs99kvQhsWq/bozC5v5AoGAK8LN
tpxd3r/BNUlkC36MopWRIoeReGsNEwFdTJaCU0+N37UetboIc0cB/IE7U4erv1Md
8OinqVAqaNfcf7pu576qSVTzAGTCKyD/RJA1FJhvtLur6sQ/CNUru6R3ybZ0B+pw
SUcN/fIRMap0i8tkSG9IGgRI/1sFz3rNnPPFSj8CgYEAxDRKsdXYqt9ux2TnVPVj
pJq7UENf/lW1+3464WTNhrmSnXi2K+/Unjn8llxzRGhNVQUbhNV1Pnhczed8GpU8
G9pqvAlHQG5VUw6E0RjxhLWQi1Sn6HnfZ08kxmpe+roIxpAwUlz4oikTPPymHDOd
6y2uXn4PU808MbDO6+Dft9g=
-----END PRIVATE KEY-----`;

async function startTlsServer(
  handler: RequestListener,
  options: { cert?: string; key?: string; host?: string } = {},
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = https.createServer(
    {
      cert: options.cert ?? VALID_PROBE_CERT,
      key: options.key ?? VALID_PROBE_KEY,
    },
    handler,
  );
  await new Promise<void>((resolve) =>
    server.listen(0, options.host ?? "127.0.0.1", () => resolve()),
  );
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function makeMockRequest(
  responder: (
    options: Parameters<HttpsRequestFn>[0],
    res: EventEmitter & {
      statusCode?: number;
      complete: boolean;
      destroy: () => void;
    },
    req: EventEmitter & { end: () => void; destroy: (err?: Error) => void },
  ) => void,
): HttpsRequestFn {
  return ((options, callback) => {
    const req = Object.assign(new EventEmitter(), {
      end() {
        const res = Object.assign(new EventEmitter(), {
          statusCode: 200,
          complete: true,
          destroy() {},
        });
        queueMicrotask(() => {
          responder(options, res, req);
        });
      },
      destroy(err?: Error) {
        if (err !== undefined) {
          queueMicrotask(() => req.emit("error", err));
        }
      },
    });
    // Store callback on req so responder invokes it when responding.
    (req as { _cb?: (res: IncomingMessage) => void })._cb = callback;
    return req as unknown as ReturnType<HttpsRequestFn>;
  }) as HttpsRequestFn;
}

describe("probeHttpsEndpoint", () => {
  it("uses relaxed defaults compatible with first-time ACME cert provisioning", () => {
    expect(TAILSCALE_PROBE_TIMEOUT_MS).toBe(8_000);
    expect(TAILSCALE_PROBE_ATTEMPTS).toBe(5);
    expect(TAILSCALE_PROBE_RETRY_DELAY_MS).toBe(1_000);
  });

  it("connects directly to tailnetIpv4 with SNI and Host header, validates cert against magicDnsName, and ignores proxy env vars", async () => {
    let seenSni: string | undefined;
    let seenHost: string | undefined;
    let seenPath: string | undefined;
    let mode: "match" | "other" | "html" | "nocontent" = "match";

    const server = await startTlsServer((req, res) => {
      seenSni = (req.socket as { servername?: string }).servername;
      seenHost = req.headers.host;
      seenPath = req.url;
      if (mode === "match") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ hostId: "host-1" }));
      } else if (mode === "other") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ hostId: "other-host" }));
      } else if (mode === "html") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<!doctype html><title>Other app</title>");
      } else {
        res.writeHead(204);
        res.end();
      }
    });

    const savedEnv = {
      http_proxy: process.env.http_proxy,
      HTTP_PROXY: process.env.HTTP_PROXY,
      https_proxy: process.env.https_proxy,
      HTTPS_PROXY: process.env.HTTPS_PROXY,
      all_proxy: process.env.all_proxy,
      ALL_PROXY: process.env.ALL_PROXY,
    };
    process.env.http_proxy = "http://127.0.0.1:1";
    process.env.HTTP_PROXY = "http://127.0.0.1:1";
    process.env.https_proxy = "http://127.0.0.1:1";
    process.env.HTTPS_PROXY = "http://127.0.0.1:1";
    process.env.all_proxy = "socks5://127.0.0.1:1";
    process.env.ALL_PROXY = "socks5://127.0.0.1:1";

    try {
      const baseUrl = `https://box.tail1234.ts.net:${server.port}`;

      expect(
        await probeHttpsEndpoint({
          baseUrl,
          tailnetIpv4: "127.0.0.1",
          expectedHostId: "host-1",
          attempts: 1,
          ca: VALID_PROBE_CERT,
        }),
      ).toBe(true);
      expect(seenSni).toBe("box.tail1234.ts.net");
      expect(seenHost).toBe(`box.tail1234.ts.net:${server.port}`);
      expect(seenPath).toBe("/.well-known/eta/host");

      mode = "other";
      expect(
        await probeHttpsEndpoint({
          baseUrl,
          tailnetIpv4: "127.0.0.1",
          expectedHostId: "host-1",
          attempts: 1,
          ca: VALID_PROBE_CERT,
        }),
      ).toBe(false);

      mode = "html";
      expect(
        await probeHttpsEndpoint({
          baseUrl,
          tailnetIpv4: "127.0.0.1",
          expectedHostId: "host-1",
          attempts: 1,
          ca: VALID_PROBE_CERT,
        }),
      ).toBe(false);

      mode = "nocontent";
      expect(
        await probeHttpsEndpoint({
          baseUrl,
          tailnetIpv4: "127.0.0.1",
          expectedHostId: "host-1",
          attempts: 1,
          ca: VALID_PROBE_CERT,
        }),
      ).toBe(false);
    } finally {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await server.close();
    }
  });

  it("rejects mismatched TLS server certificate against magicDnsName even when tailnetIpv4 connects", async () => {
    const server = await startTlsServer(
      (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ hostId: "host-1" }));
      },
      { cert: WRONG_PROBE_CERT, key: WRONG_PROBE_KEY },
    );

    try {
      expect(
        await probeHttpsEndpoint({
          baseUrl: `https://box.tail1234.ts.net:${server.port}`,
          tailnetIpv4: "127.0.0.1",
          expectedHostId: "host-1",
          attempts: 1,
          ca: WRONG_PROBE_CERT,
        }),
      ).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("works when tailnetIpv4 is omitted and falls back to url.hostname when tailnetIpv4 is unreachable", async () => {
    const ipv6Server = await startTlsServer(
      (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ hostId: "host-v6" }));
      },
      { host: "::1" },
    );

    try {
      // Omitted tailnetIpv4 -> resolves localhost directly.
      expect(
        await probeHttpsEndpoint({
          baseUrl: `https://localhost:${ipv6Server.port}`,
          expectedHostId: "host-v6",
          attempts: 1,
          ca: VALID_PROBE_CERT,
        }),
      ).toBe(true);

      // Unreachable tailnetIpv4 (nothing listens on 127.0.0.1:<port>) -> falls back to localhost (::1).
      expect(
        await probeHttpsEndpoint({
          baseUrl: `https://localhost:${ipv6Server.port}`,
          tailnetIpv4: "127.0.0.1",
          expectedHostId: "host-v6",
          attempts: 1,
          ca: VALID_PROBE_CERT,
        }),
      ).toBe(true);
    } finally {
      await ipv6Server.close();
    }
  });

  it("retries transient TLS/timeout/502 failures with real TLS servers and mock request options", async () => {
    // 1. Real TLS server: first request stalls past timeoutMs, second returns 502, third succeeds.
    let realHits = 0;
    const sleepsReal: number[] = [];
    const server = await startTlsServer((_req, res) => {
      realHits += 1;
      if (realHits === 1) {
        // Never reply on attempt 1 to trigger timeoutMs cancellation.
        return;
      }
      if (realHits === 2) {
        res.writeHead(502);
        res.end("bad gateway");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ hostId: "host-retry" }));
    });

    try {
      const ok = await probeHttpsEndpoint({
        baseUrl: `https://box.tail1234.ts.net:${server.port}`,
        tailnetIpv4: "127.0.0.1",
        expectedHostId: "host-retry",
        attempts: 4,
        delayMs: 20,
        timeoutMs: 80,
        ca: VALID_PROBE_CERT,
        sleep: async (ms) => {
          sleepsReal.push(ms);
        },
      });
      expect(ok).toBe(true);
      expect(realHits).toBe(3);
      expect(sleepsReal).toEqual([20, 20]);
    } finally {
      await server.close();
    }

    // 2. Deterministic request-level check of tailnetIpv4 -> fallback order, SNI, and Host header.
    const seenOptions: Array<{
      host?: string;
      port?: unknown;
      servername?: string;
      hostHeader?: unknown;
      path?: string;
    }> = [];
    const sleepsMock: number[] = [];
    const mockReq = makeMockRequest((options, res, req) => {
      seenOptions.push({
        host: options.host ?? undefined,
        port: options.port,
        servername: options.servername,
        hostHeader: (options.headers as Record<string, unknown> | undefined)
          ?.host,
        path: options.path ?? undefined,
      });
      const cb = (req as { _cb?: (r: IncomingMessage) => void })._cb!;
      if (options.host === "100.64.0.10") {
        req.emit("error", new Error("ECONNREFUSED"));
        return;
      }
      cb(res as unknown as IncomingMessage);
      res.emit("data", Buffer.from(JSON.stringify({ hostId: "host-abc" })));
      res.emit("end");
    });

    const reachable = await probeHttpsEndpoint({
      baseUrl: "https://desktop.example.ts.net:8443",
      tailnetIpv4: "100.64.0.10",
      expectedHostId: "host-abc",
      attempts: 3,
      delayMs: 1_000,
      request: mockReq,
      sleep: async (ms) => {
        sleepsMock.push(ms);
      },
    });
    expect(reachable).toBe(true);
    expect(sleepsMock).toEqual([]);
    expect(seenOptions).toEqual([
      {
        host: "100.64.0.10",
        port: 8443,
        servername: "desktop.example.ts.net",
        hostHeader: "desktop.example.ts.net:8443",
        path: "/.well-known/eta/host",
      },
      {
        host: "desktop.example.ts.net",
        port: 8443,
        servername: "desktop.example.ts.net",
        hostHeader: "desktop.example.ts.net:8443",
        path: "/.well-known/eta/host",
      },
    ]);
  });

  it("does not sleep after the final failed attempt and never throws on invalid or non-https baseUrl", async () => {
    const sleeps: number[] = [];
    const failingReq = makeMockRequest((_options, _res, req) => {
      req.emit("error", new Error("unreachable"));
    });

    const reachable = await probeHttpsEndpoint({
      baseUrl: "https://desktop.example.ts.net",
      expectedHostId: "host-1",
      attempts: 3,
      delayMs: 500,
      request: failingReq,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(reachable).toBe(false);
    expect(sleeps).toEqual([500, 500]);

    expect(
      await probeHttpsEndpoint({
        baseUrl: "not a url",
        expectedHostId: "host-1",
        attempts: 1,
      }),
    ).toBe(false);

    expect(
      await probeHttpsEndpoint({
        baseUrl: "http://desktop.example.ts.net",
        expectedHostId: "host-1",
        attempts: 1,
      }),
    ).toBe(false);
  });
});

describe("subprocess execution", () => {
  it("drains large serve stdout and strips raw stderr secrets on non-zero exit", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "eta-ts-test-"));
    const script = path.join(dir, "fake-tailscale.sh");
    writeFileSync(
      script,
      [
        "#!/bin/sh",
        'if [ "$1" = "status" ]; then',
        '  printf \'{"BackendState":"Running","Self":{"DNSName":"box.tail.ts.net.","CapMap":{"https":null}}}\'',
        "  exit 0",
        "fi",
        'if [ "$1" = "serve" ] && [ "$2" = "--bg" ]; then',
        "  # Emit >256KB to stdout to prove an unread pipe cannot deadlock exit.",
        "  dd if=/dev/zero bs=1024 count=260 2>/dev/null | LC_ALL=C tr '\\0' 'x'",
        "  exit 0",
        "fi",
        'echo "not logged in tskey-auth-real-subprocess-secret" >&2',
        "exit 9",
      ].join("\n"),
    );
    chmodSync(script, 0o755);

    try {
      const ts = new Tailscale({ binary: script });
      expect(ts.installed).toBe(true);
      await ts.ensureServe({ localPort: 4444 });

      let caught: unknown;
      try {
        await ts.disableServe();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(TailscaleError);
      const err = caught as TailscaleError;
      expect(err.code).toBe("exit");
      expect(err.exitCode).toBe(9);
      expect(err.diagnostic).toBe("not-logged-in");
      assertCarriesNoSecret(err, "tskey-auth-real-subprocess-secret");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
