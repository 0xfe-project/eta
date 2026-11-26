/**
 * Direct LAN and tailnet endpoint discovery, adapted from pingdotgg/t3code
 * (apps/server/src/environment/DirectEndpoints.ts, apps/server/src/startupAccess.ts,
 * packages/shared/src/hostClassification.ts; Copyright (c) 2026 T3 Tools Inc., MIT).
 */
import type { NetworkInterfaceInfo } from "node:os";
import net from "node:net";
import os from "node:os";
import process from "node:process";

export interface DirectEndpoint {
  readonly kind: "tailnet" | "lan";
  readonly address: string;
  readonly url: string;
}

export interface ResolveDirectEndpointsInput {
  readonly host: string | undefined;
  readonly port: number;
  readonly interfaces?: ReturnType<typeof os.networkInterfaces>;
  readonly platform?: NodeJS.Platform;
  /** A cloud VM's private network is its provider's, which no client shares. */
  readonly onCloudVm?: boolean;
  readonly isolatedBridges?: ReadonlySet<string>;
}

/**
 * Container and VM networks (Docker, libvirt, VMware, VirtualBox, Hyper-V, and
 * macOS's `bridge100`+) have private addresses only this machine reaches. A
 * host bridge such as `br0` or Proxmox's `vmbr0` carries the LAN address, so
 * it stays listed.
 */
const VIRTUAL_INTERFACE =
  /^(?:docker|br-|veth|virbr|vmnet|vboxnet|vEthernet|podman|cni|flannel|cali|lxcbr|lxdbr|bridge[1-9]\d\d)/;

/**
 * systemd-nspawn's `ve-*`/`vz-*` and NixOS containers' `vb-*` name host-side
 * veths after the machine. Windows aliases are user-renameable, so these
 * prefixes only apply to Linux interface discovery.
 */
const LINUX_CONTAINER_INTERFACE = /^(?:ve-|vb-|vz-)/;

// VirtualBox and VMware host-only adapters on Windows. Their names are mutable;
// Linux bridges can inherit these MACs.
const WINDOWS_HOST_ADAPTER_MAC = /^(?:0a:00:27|00:50:56:c0:00):/i;

/**
 * AWS, GCP, Azure, DigitalOcean, Hetzner, Linode, Vultr, and Oracle all serve
 * instance metadata at this address. A plain TCP connect skips HTTP proxies,
 * which would otherwise answer for a machine that is not in a cloud.
 */
const CLOUD_METADATA_ADDRESS = "169.254.169.254";
const CLOUD_METADATA_PORT = 80;
const CLOUD_METADATA_TIMEOUT_MS = 300;

export function normalizeHostname(host: string): string {
  return host
    .toLowerCase()
    .replace(/\.+$/u, "")
    .replace(/^\[|\]$/g, "");
}

export function formatHostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function parseIpv4Address(host: string): readonly number[] | null {
  const normalized = normalizeHostname(host);
  const rawParts = normalized.split(".");
  if (rawParts.length !== 4) return null;
  const parts: number[] = [];
  for (const raw of rawParts) {
    if (!/^\d{1,3}$/.test(raw)) return null;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0 || value > 255) return null;
    parts.push(value);
  }
  return parts;
}

function parseIpv6Address(host: string): readonly number[] | null {
  const normalized = normalizeHostname(host).split("%", 1)[0] ?? "";
  if (!normalized.includes(":")) return null;
  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves[1] ? halves[1].split(":") : [];
  if ([...head, ...tail].some((part) => !/^[\da-f]{1,4}$/u.test(part)))
    return null;
  const missing = 8 - head.length - tail.length;
  if (
    (halves.length === 1 && missing !== 0) ||
    (halves.length === 2 && missing < 1)
  ) {
    return null;
  }
  return [
    ...head,
    ...Array.from<string>({ length: missing }).fill("0"),
    ...tail,
  ].map((part) => Number.parseInt(part, 16));
}

function isPrivateIpv4Parts(parts: readonly number[]): boolean {
  const [a, b] = parts;
  if (a === undefined || b === undefined) return false;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 198 && b >= 18 && b <= 19)
  );
}

/** Whether `address` is an IPv4 in Tailscale's CGNAT block (`100.64.0.0/10`). */
export function isTailscaleIpv4Address(address: string): boolean {
  const parts = parseIpv4Address(address);
  return (
    parts !== null && parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127
  );
}

/** Whether `address` is in Tailscale's IPv6 ULA block (`fd7a:115c:a1e0::/48`). */
export function isTailscaleIpv6Address(address: string): boolean {
  const ipv6 = parseIpv6Address(address);
  return (
    ipv6 !== null &&
    ipv6[0] === 0xfd7a &&
    ipv6[1] === 0x115c &&
    ipv6[2] === 0xa1e0
  );
}

/**
 * Identify a Tailscale interface without relying on CGNAT IPv4 alone (which is
 * shared with Cloudflare WARP and ISP CGNAT). On macOS, `utunX` names are
 * generic, so Tailscale's `fd7a:115c:a1e0::/48` IPv6 prefix distinguishes it.
 */
export function isTailscaleInterface(
  name: string,
  entries: ReadonlyArray<NetworkInterfaceInfo>,
): boolean {
  if (/^tailscale/i.test(name)) return true;
  return entries.some(
    (entry) =>
      !entry.internal &&
      (entry.family === "IPv6" || (entry.family as unknown) === 6) &&
      isTailscaleIpv6Address(entry.address),
  );
}

export function isLoopbackHost(host: string | undefined): boolean {
  if (host === undefined || host.length === 0) return true;
  const normalized = normalizeHostname(host);
  if (normalized === "localhost" || normalized === "::1") return true;
  return parseIpv4Address(normalized)?.[0] === 127;
}

export function isWildcardHost(host: string | undefined): boolean {
  return host === "0.0.0.0" || host === "::" || host === "[::]";
}

/**
 * Loopback or private-range IPv4 (LAN, tailnet, CGNAT), excluding link-local
 * `169.254.0.0/16`, in plain or IPv4-mapped IPv6 form.
 */
export function isPrivateNetworkAddress(address: string): boolean {
  const ipv4 = address.replace(/^::ffff:/i, "");
  if (!net.isIPv4(ipv4) || ipv4.startsWith("169.254.")) return false;
  const parts = parseIpv4Address(ipv4);
  return parts !== null && isPrivateIpv4Parts(parts);
}

export function isVirtualInterface(
  name: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return (
    VIRTUAL_INTERFACE.test(name) ||
    (platform === "linux" && LINUX_CONTAINER_INTERFACE.test(name))
  );
}

// Credentials travel over HTTP; public IPs leak them and hostnames can resolve
// differently per client.
function isAdvertisableAddress(address: string): boolean {
  return (
    net.isIPv4(address) &&
    !address.startsWith("127.") &&
    isPrivateNetworkAddress(address)
  );
}

function isIpv4Family(family: string | number): boolean {
  return family === "IPv4" || family === 4;
}

/**
 * Discover reachable direct LAN and tailnet endpoints for a server bound to
 * `host:port`, filtering out virtual/container adapters, public IPs, hostnames,
 * and (on cloud VMs) unreachable VPC LAN addresses.
 */
export function resolveDirectEndpoints(
  input: ResolveDirectEndpointsInput,
): DirectEndpoint[] {
  if (isLoopbackHost(input.host)) return [];
  const interfaces = input.interfaces ?? os.networkInterfaces();
  const platform = input.platform ?? process.platform;

  const tailscaleAddresses = new Set<string>();
  for (const [name, entries] of Object.entries(interfaces)) {
    if (entries === undefined || !isTailscaleInterface(name, entries)) continue;
    for (const entry of entries) {
      tailscaleAddresses.add(entry.address);
    }
  }

  let addresses: string[];
  if (isWildcardHost(input.host)) {
    addresses = Object.entries(interfaces)
      .flatMap(([name, entries]) =>
        isVirtualInterface(name, platform) || input.isolatedBridges?.has(name)
          ? []
          : (entries ?? []),
      )
      .filter(
        (entry) =>
          !entry.internal &&
          isIpv4Family(entry.family) &&
          isAdvertisableAddress(entry.address) &&
          !(platform === "win32" && WINDOWS_HOST_ADAPTER_MAC.test(entry.mac)),
      )
      .map((entry) => entry.address);
  } else {
    const bound = input.host!.replace(/^\[|\]$/g, "");
    addresses =
      isAdvertisableAddress(bound) ||
      (net.isIPv6(bound) && isTailscaleIpv6Address(bound))
        ? [bound]
        : [];
  }

  return [...new Set(addresses)]
    .filter(
      (address) =>
        !input.onCloudVm ||
        tailscaleAddresses.has(address) ||
        isTailscaleIpv6Address(address),
    )
    .map((address) => ({
      kind:
        tailscaleAddresses.has(address) || isTailscaleIpv6Address(address)
          ? "tailnet"
          : "lan",
      address,
      url: `http://${formatHostForUrl(address)}:${input.port}`,
    }));
}

/**
 * Fast 300ms plain-TCP check for the link-local cloud instance metadata
 * endpoint (`169.254.169.254:80`). Skips HTTP proxies.
 */
export function probeCloudMetadata(
  options: {
    readonly host?: string;
    readonly port?: number;
    readonly timeoutMs?: number;
  } = {},
): Promise<boolean> {
  const host = options.host ?? CLOUD_METADATA_ADDRESS;
  const port = options.port ?? CLOUD_METADATA_PORT;
  const timeoutMs = options.timeoutMs ?? CLOUD_METADATA_TIMEOUT_MS;
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: timeoutMs });
    let settled = false;
    const settle = (found: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(found);
    };
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
  });
}
