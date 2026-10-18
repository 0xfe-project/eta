/**
 * The `machines` plugin: the computers sessions can run on.
 *
 * The list is the database, whose `status` the hub keeps true (a daemon is `online` exactly while
 * its link is up). Four things to do: name a machine, make an install code for a new one, approve
 * a pending one by its fingerprint, and revoke one.
 */
import type { MachineView } from "@eta/client-contracts";
import type { MachineHub } from "./hub";
import type { MachineRecord, MachineStore } from "./store";
import { Args, productPlugin, publish } from "../wire";

export interface MachinesDeps {
  machines: MachineStore;
  hub: MachineHub;
  changed: () => void;
  /** Where a daemon should dial when the caller does not say: this host's own address. */
  defaultUrl: () => string;
}

const viewOf = (machine: MachineRecord): MachineView => ({ ...machine });

/** What the user is told to type on the other machine. */
function installCommand(url: string, code: string): string {
  return `eta-daemon setup ${url} ${code}`;
}

export function machinesPlugin(deps: MachinesDeps, applied: () => void) {
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
        wire.handle("machines", "enroll", (call) => {
          const args = new Args(call);
          const asked = args.optionalString("url")?.trim();
          let url =
            asked === undefined || asked === "" ? deps.defaultUrl() : asked;
          try {
            const parsed = new URL(url);
            if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
              throw new Error("not http(s)");
            url = `${parsed.protocol}//${parsed.host}`;
          } catch {
            throw new Error(`machines.enroll: not an address: ${url}`);
          }
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
      ];
      return () => {
        for (const off of offs.splice(0)) off();
      };
    },
    applied,
  );
}
