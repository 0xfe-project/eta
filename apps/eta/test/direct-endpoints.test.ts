import type os from "node:os";
import net from "node:net";
import { describe, expect, it } from "vitest";
import {
  formatHostForUrl,
  isLoopbackHost,
  isPrivateNetworkAddress,
  isVirtualInterface,
  isWildcardHost,
  normalizeHostname,
  probeCloudMetadata,
  resolveDirectEndpoints,
} from "../src/machines/direct-endpoints";

const INTERFACES: ReturnType<typeof os.networkInterfaces> = {
  lo0: [
    {
      address: "127.0.0.1",
      netmask: "255.0.0.0",
      family: "IPv4",
      mac: "00:00:00:00:00:00",
      internal: true,
      cidr: "127.0.0.1/8",
    },
  ],
  en0: [
    {
      address: "192.168.1.10",
      netmask: "255.255.255.0",
      family: "IPv4",
      mac: "aa:bb:cc:dd:ee:ff",
      internal: false,
      cidr: "192.168.1.10/24",
    },
    {
      address: "fe80::1",
      netmask: "ffff:ffff:ffff:ffff::",
      family: "IPv6",
      mac: "aa:bb:cc:dd:ee:ff",
      internal: false,
      cidr: "fe80::1/64",
      scopeid: 4,
    },
  ],
  en1: [
    {
      address: "203.0.113.20",
      netmask: "255.255.255.0",
      family: "IPv4",
      mac: "aa:bb:cc:dd:ee:00",
      internal: false,
      cidr: "203.0.113.20/24",
    },
  ],
  en2: [
    {
      address: "169.254.12.34",
      netmask: "255.255.0.0",
      family: "IPv4",
      mac: "aa:bb:cc:dd:ee:01",
      internal: false,
      cidr: "169.254.12.34/16",
    },
  ],
  utun4: [
    {
      address: "100.101.102.103",
      netmask: "255.255.255.255",
      family: "IPv4",
      mac: "00:00:00:00:00:00",
      internal: false,
      cidr: "100.101.102.103/32",
    },
    {
      address: "fd7a:115c:a1e0::1",
      netmask: "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
      family: "IPv6",
      mac: "00:00:00:00:00:00",
      internal: false,
      cidr: "fd7a:115c:a1e0::1/128",
      scopeid: 0,
    },
  ],
};

const vpnInterface = (address: string) => [
  {
    address,
    netmask: "255.255.255.255",
    family: "IPv4" as const,
    mac: "00:00:00:00:00:00",
    internal: false,
    cidr: `${address}/32`,
  },
];

const virtualInterface = (address: string, mac = "02:42:ac:11:00:01") => [
  {
    address,
    netmask: "255.255.0.0",
    family: "IPv4" as const,
    mac,
    internal: false,
    cidr: `${address}/16`,
  },
];

describe("host classification helpers", () => {
  it("classifies loopback, wildcard, private network, and virtual interfaces", () => {
    expect(normalizeHostname("[::1].")).toBe("::1");
    expect(formatHostForUrl("fd7a:115c:a1e0::1")).toBe("[fd7a:115c:a1e0::1]");
    expect(formatHostForUrl("[::1]")).toBe("[::1]");
    expect(formatHostForUrl("192.168.1.10")).toBe("192.168.1.10");

    expect(isLoopbackHost(undefined)).toBe(true);
    expect(isLoopbackHost("")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.0.0.2")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("192.168.1.10")).toBe(false);

    expect(isWildcardHost("0.0.0.0")).toBe(true);
    expect(isWildcardHost("::")).toBe(true);
    expect(isWildcardHost("[::]")).toBe(true);
    expect(isWildcardHost("127.0.0.1")).toBe(false);

    expect(isPrivateNetworkAddress("10.0.0.5")).toBe(true);
    expect(isPrivateNetworkAddress("172.16.0.1")).toBe(true);
    expect(isPrivateNetworkAddress("192.168.1.10")).toBe(true);
    expect(isPrivateNetworkAddress("100.64.1.2")).toBe(true);
    expect(isPrivateNetworkAddress("::ffff:192.168.1.10")).toBe(true);
    expect(isPrivateNetworkAddress("169.254.169.254")).toBe(false);
    expect(isPrivateNetworkAddress("203.0.113.20")).toBe(false);

    expect(isVirtualInterface("docker0", "linux")).toBe(true);
    expect(isVirtualInterface("bridge100", "darwin")).toBe(true);
    expect(isVirtualInterface("vmbr0", "linux")).toBe(false);
    expect(isVirtualInterface("ve-jellyfin", "linux")).toBe(true);
    expect(isVirtualInterface("ve-office", "win32")).toBe(false);
  });
});

describe("resolveDirectEndpoints", () => {
  it("lists every external private IPv4 address for a wildcard bind, tagging the tailnet one", () => {
    expect(
      resolveDirectEndpoints({
        platform: "linux",
        host: "0.0.0.0",
        port: 3773,
        interfaces: INTERFACES,
      }),
    ).toEqual([
      {
        kind: "lan",
        address: "192.168.1.10",
        url: "http://192.168.1.10:3773",
      },
      {
        kind: "tailnet",
        address: "100.101.102.103",
        url: "http://100.101.102.103:3773",
      },
    ]);
  });

  it("skips container and VM networks and isolated bridges", () => {
    const interfaces = {
      ...INTERFACES,
      docker0: virtualInterface("172.17.0.1"),
      "br-3f2a1b": virtualInterface("172.18.0.1"),
      virbr0: virtualInterface("192.168.122.1"),
      "vEthernet (WSL)": virtualInterface("172.24.0.1"),
      bridge100: virtualInterface("192.168.64.1"),
      vmbr0: virtualInterface("192.168.1.20"),
      fhciowner: virtualInterface("10.221.0.1"),
    };
    expect(
      resolveDirectEndpoints({
        platform: "linux",
        host: "0.0.0.0",
        port: 3773,
        interfaces,
        isolatedBridges: new Set(["fhciowner"]),
      }),
    ).toEqual([
      {
        kind: "lan",
        address: "192.168.1.10",
        url: "http://192.168.1.10:3773",
      },
      {
        kind: "tailnet",
        address: "100.101.102.103",
        url: "http://100.101.102.103:3773",
      },
      {
        kind: "lan",
        address: "192.168.1.20",
        url: "http://192.168.1.20:3773",
      },
    ]);
  });

  it("skips Linux container veths while keeping Windows aliases", () => {
    const interfaces = {
      ...INTERFACES,
      "ve-jellyfin": virtualInterface("192.168.53.193"),
      "vb-jellyfin": virtualInterface("192.168.100.1"),
      "vz-machine": virtualInterface("192.168.101.1"),
    };
    expect(
      resolveDirectEndpoints({
        platform: "linux",
        host: "0.0.0.0",
        port: 3773,
        interfaces,
      }),
    ).toEqual([
      {
        kind: "lan",
        address: "192.168.1.10",
        url: "http://192.168.1.10:3773",
      },
      {
        kind: "tailnet",
        address: "100.101.102.103",
        url: "http://100.101.102.103:3773",
      },
    ]);

    expect(
      resolveDirectEndpoints({
        platform: "win32",
        host: "0.0.0.0",
        port: 3773,
        interfaces: {
          ...INTERFACES,
          "ve-office": virtualInterface("192.168.1.30"),
        },
      }),
    ).toEqual([
      {
        kind: "lan",
        address: "192.168.1.10",
        url: "http://192.168.1.10:3773",
      },
      {
        kind: "tailnet",
        address: "100.101.102.103",
        url: "http://100.101.102.103:3773",
      },
      {
        kind: "lan",
        address: "192.168.1.30",
        url: "http://192.168.1.30:3773",
      },
    ]);
  });

  it("omits Windows host-only adapters without excluding guest NICs or explicit binds", () => {
    const interfaces = {
      ...INTERFACES,
      "VirtualBox-Host-Only": virtualInterface(
        "192.168.56.1",
        "0A:00:27:00:01:01",
      ),
      "Ethernet 2": virtualInterface("192.168.150.1", "00:50:56:c0:00:01"),
      guest1: virtualInterface("192.168.1.30", "08:00:27:5e:1a:22"),
    };
    expect(
      resolveDirectEndpoints({
        platform: "win32",
        host: "0.0.0.0",
        port: 3773,
        interfaces,
      }),
    ).toEqual([
      {
        kind: "lan",
        address: "192.168.1.10",
        url: "http://192.168.1.10:3773",
      },
      {
        kind: "tailnet",
        address: "100.101.102.103",
        url: "http://100.101.102.103:3773",
      },
      {
        kind: "lan",
        address: "192.168.1.30",
        url: "http://192.168.1.30:3773",
      },
    ]);

    expect(
      resolveDirectEndpoints({
        platform: "win32",
        host: "192.168.56.1",
        port: 3773,
        interfaces,
      }),
    ).toEqual([
      {
        kind: "lan",
        address: "192.168.56.1",
        url: "http://192.168.56.1:3773",
      },
    ]);
  });

  it("tags only Tailscale interfaces as tailnet, not Cloudflare WARP or other CGNAT VPNs", () => {
    const interfaces = {
      en0: INTERFACES.en0,
      tailscale0: vpnInterface("100.70.1.2"),
      CloudflareWARP: vpnInterface("100.96.0.1"),
      utun7: vpnInterface("100.85.0.1"),
    };
    expect(
      resolveDirectEndpoints({
        platform: "linux",
        host: "0.0.0.0",
        port: 3773,
        interfaces,
      }),
    ).toEqual([
      {
        kind: "lan",
        address: "192.168.1.10",
        url: "http://192.168.1.10:3773",
      },
      {
        kind: "tailnet",
        address: "100.70.1.2",
        url: "http://100.70.1.2:3773",
      },
      {
        kind: "lan",
        address: "100.96.0.1",
        url: "http://100.96.0.1:3773",
      },
      {
        kind: "lan",
        address: "100.85.0.1",
        url: "http://100.85.0.1:3773",
      },
    ]);
  });

  it("omits loopback, hostnames, public IPs, and IPv4-mapped loopback", () => {
    for (const host of [
      undefined,
      "127.0.0.1",
      "::1",
      "localhost",
      "server.local",
      "devbox",
      "203.0.113.20",
      "::ffff:127.0.0.1",
    ]) {
      expect(
        resolveDirectEndpoints({
          platform: "linux",
          host,
          port: 3773,
          interfaces: INTERFACES,
        }),
      ).toEqual([]);
    }
  });

  it("reports only tailnet addresses on a cloud VM", () => {
    expect(
      resolveDirectEndpoints({
        platform: "linux",
        host: "0.0.0.0",
        port: 3773,
        interfaces: INTERFACES,
        onCloudVm: true,
      }),
    ).toEqual([
      {
        kind: "tailnet",
        address: "100.101.102.103",
        url: "http://100.101.102.103:3773",
      },
    ]);
  });

  it("reports an explicit bind to Tailscale IPv6 as tailnet", () => {
    expect(
      resolveDirectEndpoints({
        platform: "linux",
        host: "fd7a:115c:a1e0::1",
        port: 3773,
        interfaces: INTERFACES,
      }),
    ).toEqual([
      {
        kind: "tailnet",
        address: "fd7a:115c:a1e0::1",
        url: "http://[fd7a:115c:a1e0::1]:3773",
      },
    ]);
  });
});

describe("probeCloudMetadata", () => {
  it("detects a reachable metadata TCP endpoint and rejects an unreachable one", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );
    const port = (server.address() as net.AddressInfo).port;
    try {
      expect(
        await probeCloudMetadata({ host: "127.0.0.1", port, timeoutMs: 300 }),
      ).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    expect(
      await probeCloudMetadata({ host: "127.0.0.1", port, timeoutMs: 300 }),
    ).toBe(false);
  });
});
