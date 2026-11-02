/**
 * What Tailscale on this computer knows: the nodes of the tailnet, and who is behind an address.
 *
 * Read through the `tailscale` command (`status --json`, `whois --json`, `ip -4`), which every
 * platform has and whose JSON is stable; there is no JavaScript SDK for the local node. On macOS
 * the command lives inside the app when it is not on the PATH. No command, or a node that is not
 * up, is "no tailnet": discovery is empty and nobody is let in on the tailnet's word.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import process from "node:process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** One node of the tailnet, as discovery shows it. */
interface TailnetNode {
  /** The stable node id: what a machine row remembers. */
  node: string;
  /** Its hostname. */
  name: string;
  /** Its MagicDNS name, without the trailing dot; empty when MagicDNS is off. */
  dnsName: string;
  addresses: string[];
  os: string;
  online: boolean;
  /** The login of the user it belongs to; null for a tagged node, which belongs to no user. */
  login: string | null;
  tags: string[];
}

export interface TailnetStatus {
  self: TailnetNode;
  peers: TailnetNode[];
}

/** Who is behind an address, as Tailscale tells it. */
export interface TailnetWho {
  node: string;
  name: string;
  /** Null for a tagged node. */
  login: string | null;
  tags: string[];
}

/** Runs the command with arguments and gives its standard output. */
export type TailscaleRunner = (args: string[]) => Promise<string>;

const MAC_APP = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

function defaultRunner(): TailscaleRunner | undefined {
  const binary =
    Bun.which("tailscale") ??
    (process.platform === "darwin" && existsSync(MAC_APP) ? MAC_APP : null);
  if (binary === null) return undefined;
  return async (args) =>
    (await exec(binary, args, { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 }))
      .stdout;
}

interface RawNode {
  ID?: string;
  HostName?: string;
  DNSName?: string;
  TailscaleIPs?: string[];
  OS?: string;
  Online?: boolean;
  UserID?: number;
  Tags?: string[];
}

interface RawStatus {
  BackendState?: string;
  Self?: RawNode;
  Peer?: Record<string, RawNode>;
  User?: Record<string, { LoginName?: string }>;
}

/** `::ffff:100.64.0.1` is `100.64.0.1`. */
function plainAddress(address: string): string {
  return address.startsWith("::ffff:") ? address.slice(7) : address;
}

export class Tailscale {
  readonly #run: TailscaleRunner | undefined;

  constructor(options: { run?: TailscaleRunner | undefined } = {}) {
    this.#run = options.run ?? defaultRunner();
  }

  /** Whether there is a `tailscale` command at all. */
  get installed(): boolean {
    return this.#run !== undefined;
  }

  /** The tailnet as this node sees it; undefined when there is no command or the node is not up. */
  async status(): Promise<TailnetStatus | undefined> {
    if (this.#run === undefined) return undefined;
    let raw: RawStatus;
    try {
      raw = JSON.parse(await this.#run(["status", "--json"])) as RawStatus;
    } catch {
      return undefined;
    }
    if (raw.BackendState !== "Running" || raw.Self === undefined)
      return undefined;
    const users = raw.User ?? {};
    const nodeOf = (node: RawNode, online: boolean): TailnetNode => {
      const tags = node.Tags ?? [];
      const login =
        tags.length > 0 || node.UserID === undefined
          ? null
          : (users[String(node.UserID)]?.LoginName ?? null);
      return {
        node: node.ID ?? "",
        name: node.HostName ?? "",
        dnsName: (node.DNSName ?? "").replace(/\.$/, ""),
        addresses: node.TailscaleIPs ?? [],
        os: node.OS ?? "",
        online,
        login,
        tags,
      };
    };
    return {
      self: nodeOf(raw.Self, true),
      peers: Object.values(raw.Peer ?? {})
        .map((peer) => nodeOf(peer, peer.Online === true))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  /** Who is behind a tailnet address; undefined when it is not one Tailscale knows. */
  async whois(address: string): Promise<TailnetWho | undefined> {
    if (this.#run === undefined) return undefined;
    try {
      const raw = JSON.parse(
        await this.#run(["whois", "--json", plainAddress(address)]),
      ) as {
        Node?: {
          StableID?: string;
          ID?: string;
          Name?: string;
          Tags?: string[];
        };
        UserProfile?: { LoginName?: string };
      };
      if (raw.Node === undefined) return undefined;
      const tags = raw.Node.Tags ?? [];
      return {
        node: raw.Node.StableID ?? String(raw.Node.ID ?? ""),
        name: (raw.Node.Name ?? "").replace(/\.$/, ""),
        login: tags.length > 0 ? null : (raw.UserProfile?.LoginName ?? null),
        tags,
      };
    } catch {
      return undefined;
    }
  }

  /** This node's IPv4 address on the tailnet; undefined without one. */
  async address(): Promise<string | undefined> {
    if (this.#run === undefined) return undefined;
    try {
      const first = (await this.#run(["ip", "-4"]))
        .trim()
        .split("\n")[0]
        ?.trim();
      return first === undefined || first === "" ? undefined : first;
    } catch {
      return undefined;
    }
  }

  /**
   * Whether the node behind an address is one of the user's own: it belongs to the same login as
   * this node, and is not a tagged node (which belongs to no one). Its node id when it is.
   */
  async ownNode(address: string): Promise<{ node: string } | undefined> {
    const [status, who] = await Promise.all([
      this.status(),
      this.whois(address),
    ]);
    if (status === undefined || who === undefined) return undefined;
    // This very node is not another machine of the user's: it is a proxy in front of the host (a
    // request from the internet that a local Caddy passed on) or a process on this computer, and
    // whoever is behind it is not known.
    if (who.node === status.self.node) return undefined;
    if (who.login === null || who.tags.length > 0) return undefined;
    if (status.self.login === null || who.login !== status.self.login)
      return undefined;
    return { node: who.node };
  }
}
