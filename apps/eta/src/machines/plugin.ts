/**
 * The `machines` plugin: the computers sessions can run on.
 *
 * The list is the database, whose `status` the hub keeps true (a daemon is `online` exactly while
 * its link is up). What can be done: name a machine, make an install code for a new one, approve
 * a pending one by its fingerprint, revoke one, bring one's daemon up to date, look at the tailnet
 * for computers to add, and put the daemon on one of them over SSH.
 *
 * An install over SSH takes a while (a build is tens of megabytes): the call returns at once and
 * its steps are the `installs` section, which the page watches.
 */
import type {
  MachineInstallView,
  MachineView,
  TailnetPeerView,
} from "@eta/client-contracts";
import type { DaemonBuilds } from "./builds";
import type { MachineHub } from "./hub";
import type { SshRunner } from "./install";
import type { MachineRecord, MachineStore } from "./store";
import type { Tailscale } from "./tailscale";
import { Args, productPlugin, publish } from "../wire";
import { installDaemon } from "./install";
import { installCommand } from "./install-script";

export interface MachinesDeps {
  machines: MachineStore;
  hub: MachineHub;
  changed: () => void;
  /** Where a daemon should dial when the caller does not say: this host's own address. */
  defaultUrl: () => Promise<string>;
  /** This host's tailnet address, when it listens there. */
  tailnetUrl: () => Promise<string | undefined>;
  /** Tailscale on this host, for discovery; without it the tailnet is never looked at. */
  tailscale?: Tailscale | undefined;
  /** The daemon builds carried, what `install` sends. */
  builds?: DaemonBuilds | undefined;
  /** How `install` reaches a computer. */
  ssh: SshRunner;
  /** The token a client needs, when the host asks for one. */
  accessToken?: string | undefined;
  now?: (() => number) | undefined;
}

/** The installs kept for the page: enough to see the last few, never a history. */
const KEEP_INSTALLS = 10;

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
  const installs: MachineInstallView[] = [];
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
          {
            list: () => deps.machines.list().map(viewOf),
            installs: () => installs.map((install) => ({ ...install })),
          },
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
        // The token goes to a client that is already in: this socket can do all the token can.
        wire.handle("machines", "phoneLink", async (call) => {
          const url = await urlFor(
            new Args(call).optionalString("url"),
            "phoneLink",
          );
          const query = new URLSearchParams({
            address: url,
            ...(deps.accessToken === undefined
              ? {}
              : { token: deps.accessToken }),
          });
          return { result: { link: `eta://connect?${query}`, url } };
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
        wire.handle("machines", "addresses", async () => ({
          result: { tailnet: (await deps.tailnetUrl()) ?? null },
        })),
        wire.handle("machines", "install", async (call) => {
          const args = new Args(call);
          const host = args.string("host").trim();
          // Something `ssh` would read as an option is not a host.
          if (host === "" || host.startsWith("-") || /\s/.test(host))
            throw new Error(`machines.install: not a host: ${host}`);
          const builds = deps.builds;
          if (builds === undefined)
            throw new Error("this primary carries no daemon builds");
          const url = await urlFor(args.optionalString("url"), "install");
          const name = args.optionalString("name")?.trim();
          const password = args.optionalString("password");
          const { code } = deps.machines.enroll(
            name === undefined || name === ""
              ? host.replace(/^.*@/, "").split(".")[0]
              : name,
          );
          const install: MachineInstallView = {
            id: crypto.randomUUID(),
            host,
            step: "connect",
            error: null,
            machineId: null,
            startedAt: (deps.now ?? Date.now)(),
          };
          installs.unshift(install);
          installs.splice(KEEP_INSTALLS);
          const moved = (): void => wire.pushNow("machines");
          moved();
          // The call is answered now; the install goes on, and its steps are the section.
          void installDaemon(
            { host, url, code, password },
            {
              builds,
              ssh: deps.ssh,
              onStep: (step) => {
                install.step = step;
                moved();
              },
            },
          ).then(
            () => {
              install.step = "done";
              install.machineId = deps.machines.enrolledWith(code)?.id ?? null;
              deps.changed();
              moved();
            },
            (error: unknown) => {
              install.step = "failed";
              install.error =
                error instanceof Error ? error.message : String(error);
              moved();
            },
          );
          return { result: { installId: install.id } };
        }),
      ];
      return () => {
        for (const off of offs.splice(0)) off();
      };
    },
    applied,
  );
}
