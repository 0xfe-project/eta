/**
 * The `acp` plugin: the settings page's view of the ACP agents this host runs, and the calls
 * that add, change, remove and try one.
 *
 * One section, `list`, pushed when it changes. `save` adds an agent (no `previousId`), changes
 * one in place (`previousId` is its id) or renames one (`previousId` is its old id). `test` takes
 * a configuration that need not be saved.
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
        publish(wire, "acp", { list: () => service.list() }),

        wire.handle("acp", "save", async (call) => {
          const args = new Args(call);
          return {
            result: await service.save(
              agentOf(call),
              args.optionalString("previousId"),
            ),
          };
        }),

        wire.handle("acp", "delete", async (call) => {
          service.delete(new Args(call).string("id"));
          return { result: {} };
        }),

        wire.handle("acp", "test", async (call) => ({
          result: await service.test(agentOf(call)),
        })),
      ];
      return () => {
        for (const off of offs.splice(0)) off();
      };
    },
    applied,
  );
}
