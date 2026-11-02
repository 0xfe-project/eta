/**
 * The `machines` plugin: the computers sessions can run on.
 *
 * The list is the database, whose `status` the hub keeps true (a daemon is `online` exactly while
 * its link is up). What can be done: name a machine, make an install code for a new one, approve
 * a pending one by its fingerprint, revoke one, bring one's daemon up to date, look at the tailnet
 * for computers to add, and put the daemon on one of them over SSH.
 */
import type { MachineView, TailnetPeerView } from "@eta/client-contracts";
import type { DaemonBuilds } from "./builds";
import type { MachineHub } from "./hub";
import type { SshRunner } from "./install";
import type { MachineRecord, MachineStore } from "./store";
import type { Tailscale } from "./tailscale";
import { Args, productPlugin, publish } from "../wire";
import { installDaemon } from "./install";

export interface MachinesDeps {
  machines: MachineStore;
  hub: MachineHub;
  changed: () => void;
  /** Where a daemon should dial when the caller does not say: this host's own address. */
  defaultUrl: () => Promise<string>;
  /** Tailscale on this host, for discovery; without it the tailnet is never looked at. */
  tailscale?: Tailscale | undefined;
  /** The daemon builds carried, what `install` sends. */
  builds?: DaemonBuilds | undefined;
  /** How `install` reaches a computer; the user's `ssh` by default. */
  ssh?: SshRunner | undefined;
}

/** What the user is told to type on the other machine. */
function installCommand(url: string, code: string): string {
  return `eta-daemon setup ${url} ${code}`;
}

/** An address a daemon can dial: `http(s)://host[:port]`, and nothing after it. */
function originOf(url: string, action: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      throw new Error("not http(s)");
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    throw new Error(`machines.${action}: not an address: ${url}`);
  }
}

export function machinesPlugin(deps: MachinesDeps, applied: () => void) {
  const viewOf = (machine: MachineRecord): MachineView => ({
    ...machine,
    build: deps.hub.buildOf(machine),
  });

  const urlFor = async (asked: string | undefined, action: string) =>
    originOf(
      asked === undefined || asked.trim() === ""
        ? await deps.defaultUrl()
        : asked.trim(),
      action,
    );

  return productPlugin(
    "machines",
    ({ wire }) => {
      const offs = [
        publish(
          wire,
          "machines",
          { list: () => deps.machines.list().map(viewOf) },
          { eager: true },
        ),
        wire.handle("machines", "rename", (call) => {
          const args = new Args(call);
          const machine = deps.machines.rename(
            args.string("machineId"),
            args.string("name").trim(),
          );
          if (machine === undefined) throw new Error("no such machine");
          deps.changed();
          return { result: { machine: viewOf(machine) } };
        }),
        wire.handle("machines", "setMaxActiveRuns", (call) => {
          const args = new Args(call);
          const machine = deps.machines.setMaxActiveRuns(
            args.string("machineId"),
            args.integer("maxActiveRuns"),
          );
          if (machine === undefined) throw new Error("no such machine");
          deps.changed();
          return { result: { machine: viewOf(machine) } };
        }),
        wire.handle("machines", "enroll", async (call) => {
          const args = new Args(call);
          const url = await urlFor(args.optionalString("url"), "enroll");
          const { code, expiresAt } = deps.machines.enroll(
            args.optionalString("name"),
          );
          return {
            result: {
              code,
              expiresAt,
              url,
              command: installCommand(url, code),
            },
          };
        }),
        wire.handle("machines", "approve", (call) => {
          const args = new Args(call);
          const machine = deps.hub.approve(
            args.string("machineId"),
            args.string("fingerprint"),
          );
          return { result: { machine: viewOf(machine) } };
        }),
        wire.handle("machines", "revoke", (call) => {
          const args = new Args(call);
          const machine = deps.hub.revoke(args.string("machineId"));
          return { result: { machine: viewOf(machine) } };
        }),
        wire.handle("machines", "upgrade", async (call) => {
          const machine = await deps.hub.upgrade(
            new Args(call).string("machineId"),
          );
          deps.changed();
          return { result: { machine: viewOf(machine) } };
        }),
        wire.handle("machines", "discover", async () => {
          const status = await deps.tailscale?.status();
          if (status === undefined)
            return {
              result: {
                available: false,
                reason:
                  deps.tailscale?.installed === true
                    ? "Tailscale is not running on this host"
                    : "Tailscale is not installed on this host",
                peers: [],
              },
            };
          const machines = deps.machines.list();
          const peers: TailnetPeerView[] = status.peers.map((peer) => {
            // A node that came in over the tailnet is known by its id; one added by hand may still
            // be recognised by its name.
            const known =
              deps.machines.byTailnetNode(peer.node) ??
              machines.find(
                (machine) =>
                  machine.kind === "daemon" &&
                  machine.status !== "revoked" &&
                  machine.name.toLowerCase() === peer.name.toLowerCase(),
              );
            return {
              node: peer.node,
              name: peer.name,
              dnsName: peer.dnsName,
              os: peer.os,
              online: peer.online,
              login: peer.login,
              own:
                peer.login !== null &&
                status.self.login !== null &&
                peer.login === status.self.login,
              machineId: known?.id ?? null,
            };
          });
          return {
            result: {
              available: true,
              self: {
                name: status.self.name,
                dnsName: status.self.dnsName,
                login: status.self.login,
              },
              peers,
            },
          };
        }),
        wire.handle("machines", "install", async (call) => {
          const args = new Args(call);
          const host = args.string("host").trim();
          // Something `ssh` would read as an option is not a host.
          if (host === "" || host.startsWith("-") || /\s/.test(host))
            throw new Error(`machines.install: not a host: ${host}`);
          if (deps.builds === undefined)
            throw new Error("this primary carries no daemon builds");
          const url = await urlFor(args.optionalString("url"), "install");
          const name = args.optionalString("name")?.trim();
          const { code } = deps.machines.enroll(
            name === undefined || name === ""
              ? host.replace(/^.*@/, "").split(".")[0]
              : name,
          );
          const { platform } = await installDaemon(
            { host, url, code },
            { builds: deps.builds, ssh: deps.ssh },
          );
          const machine = deps.machines.enrolledWith(code);
          deps.changed();
          return {
            result: {
              machine: machine === undefined ? null : viewOf(machine),
              platform,
            },
          };
        }),
      ];
      return () => {
        for (const off of offs.splice(0)) off();
      };
    },
    applied,
  );
}
