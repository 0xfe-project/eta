/**
 * Running a script on a project's machine, whichever machine that is.
 *
 * The primary is this process's own shell; a daemon machine is the same script sent over the link
 * (`LinkTransport`). Both are an `SshTransport`, so what is written against it (a file listing, an
 * attachment delivered into a session's reach) is written once.
 */
import type { SshTransport } from "@eta/ssh";
import type { MachineHub } from "./hub";
import type { MachineRecord } from "./store";
import { LocalTransport } from "@eta/ssh";
import { LinkTransport } from "./link-transport";

export function transportOn(
  machine: MachineRecord,
  hub: MachineHub,
): SshTransport {
  if (machine.kind === "primary") return new LocalTransport();
  if (machine.kind === "daemon") {
    const link = hub.link(machine.id);
    if (link === undefined)
      throw new Error(`${machine.name} is ${machine.status}`);
    return new LinkTransport(link, machine.home ?? "/");
  }
  throw new Error(`${machine.name} cannot be reached from this host yet`);
}
