/**
 * The `machines` plugin: the computers sessions can run on.
 *
 * Only the primary exists today, and the only thing to do with it is name it. Enrolling a daemon
 * and the rest of a machine's life arrive with the daemon; the target already has the shape.
 */
import type { MachineView } from "@eta/client-contracts";
import type { MachineRecord, MachineStore } from "./store";
import { Args, productPlugin, publish } from "../wire";

export interface MachinesDeps {
  machines: MachineStore;
  changed: () => void;
}

const viewOf = (machine: MachineRecord): MachineView => ({ ...machine });

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
      ];
      return () => {
        for (const off of offs.splice(0)) off();
      };
    },
    applied,
  );
}
