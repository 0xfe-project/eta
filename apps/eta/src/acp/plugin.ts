/**
 * The `acp` plugin: the settings page's view of the ACP agents each machine runs, and the calls
 * that add, change, remove and try one on one machine.
 *
 * One section, `machines`: every known machine's list (or why its file cannot be read), by
 * machine id, pushed when one changes. The primary's is always there; a daemon's once
 * `refresh` asked for it. Every call takes a `machineId`, the primary when absent; a daemon that
 * is offline is an error. `save` adds an agent (no `previousId`), changes one in place
 * (`previousId` is its id) or renames one (`previousId` is its old id). `test` takes a
 * configuration that need not be saved.
 */
import type { CallFrame } from "@eta/client-wire-proto";
import type { AcpService } from "./service";
import { Args, productPlugin, publish } from "../wire";

export interface AcpPluginDeps {
  service: AcpService;
}

/** The `agent` argument, as the caller sent it; the service checks what is in it. */
function agentOf(call: CallFrame): unknown {
  const agent = (call.args as { agent?: unknown } | null | undefined)?.agent;
  if (typeof agent !== "object" || agent === null || Array.isArray(agent))
    throw new Error(`${call.target}.${call.action} needs agent`);
  return agent;
}

export function acpPlugin(deps: AcpPluginDeps, applied: () => void) {
  const { service } = deps;
  return productPlugin(
    "acp",
    ({ wire }) => {
      const offs = [
        publish(wire, "acp", { machines: () => service.lists() }),

        wire.handle("acp", "refresh", async (call) => ({
          result: await service.refresh(
            new Args(call).optionalString("machineId"),
          ),
        })),

        wire.handle("acp", "save", async (call) => {
          const args = new Args(call);
          return {
            result: await service.save(
              args.optionalString("machineId"),
              agentOf(call),
              args.optionalString("previousId"),
            ),
          };
        }),

        wire.handle("acp", "deletePreview", (call) => {
          const args = new Args(call);
          return {
            result: service.deletePreview(
              args.optionalString("machineId"),
              args.string("id"),
            ),
          };
        }),

        wire.handle("acp", "delete", async (call) => {
          const args = new Args(call);
          const deleteAgents = args.optionalBoolean("deleteAgents");
          return {
            result: await service.delete(
              args.optionalString("machineId"),
              args.string("id"),
              deleteAgents === undefined ? undefined : { deleteAgents },
            ),
          };
        }),

        wire.handle("acp", "test", async (call) => ({
          result: await service.test(
            new Args(call).optionalString("machineId"),
            agentOf(call),
          ),
        })),
      ];
      return () => {
        for (const off of offs.splice(0)) off();
      };
    },
    applied,
  );
}
