/** Whether a path names a directory on a machine, asked of the machine that has it. */
import type { MachineHub } from "../machines/hub";
import type { MachineRecord } from "../machines/store";
import { stat } from "node:fs/promises";

/**
 * Whether `path` is a directory on the machine; says why not otherwise. A daemon machine is asked:
 * the path means something on its filesystem, and it is the only one who can say.
 */
export async function checkDirectory(
  machine: MachineRecord,
  hub: MachineHub,
  path: string,
): Promise<void> {
  if (machine.kind === "daemon") {
    const link = hub.link(machine.id);
    if (link === undefined) {
      throw new Error(
        `${machine.name} is ${machine.status}, so ${path} cannot be checked`,
      );
    }
    const answer = await link.machine("stat", { path });
    if (!answer.ok) throw new Error(answer.reason);
    return;
  }
  if (machine.kind !== "primary")
    throw new Error(`${machine.name} cannot be reached from this host yet`);
  const found = await stat(path).catch(() => undefined);
  if (found === undefined) throw new Error(`no such directory: ${path}`);
  if (!found.isDirectory()) throw new Error(`not a directory: ${path}`);
}
