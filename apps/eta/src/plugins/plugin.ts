/**
 * The `plugins` plugin: the settings page's view of plugins, and the calls that change them.
 *
 * A secret goes in through `configure` and is never read back: no section and no answer here has
 * a secret's value, only whether one is set.
 */
import type { PluginAuditView, PluginValue } from "@eta/client-contracts";
import type { AgentStore } from "../agents/store";
import type { Plugins } from "./service";
import { Args, productPlugin, publish } from "../wire";

const LEVELS = ["none", "read", "file", "value"] as const;
const AUDIT_SHOWN = 200;

export function pluginsPlugin(
  deps: { plugins: Plugins; agents: AgentStore },
  applied: () => void,
) {
  const { plugins, agents } = deps;
  return productPlugin(
    "plugins",
    ({ wire }) => {
      const offs = [
        publish(wire, "plugins", {
          list: () => plugins.view(),
          audit: (): PluginAuditView[] =>
            plugins.rows.audits(AUDIT_SHOWN).map((row) => ({
              ...row,
              agentName:
                row.agentId === null
                  ? null
                  : (agents.get(row.agentId)?.name ?? null),
            })),
        }),
        wire.handle("plugins", "configure", (call) => {
          const name = new Args(call).string("name");
          const { values } = (call.args ?? {}) as { values?: unknown };
          if (
            typeof values !== "object" ||
            values === null ||
            Array.isArray(values)
          )
            throw new Error("plugins.configure needs values");
          return {
            result: {
              name,
              ...plugins.configure(
                name,
                values as Record<string, PluginValue | null>,
              ),
            },
          };
        }),
        wire.handle("plugins", "setLevel", (call) => {
          const args = new Args(call);
          const name = args.string("name");
          const level = args.string("level");
          if (!LEVELS.includes(level as never))
            throw new Error(`unknown level: ${level}`);
          plugins.setLevel(
            name,
            args.string("field"),
            level as (typeof LEVELS)[number],
          );
          return { result: { name } };
        }),
        wire.handle("plugins", "add", async (call) => {
          const args = new Args(call);
          const name = await plugins.registry.add(
            args.string("repo"),
            args.optionalString("rev") ?? "",
            args.optionalString("path") ?? "",
          );
          return { result: { name } };
        }),
        wire.handle("plugins", "update", async (call) => {
          const names = await plugins.update(
            new Args(call).optionalString("name"),
          );
          return { result: { names } };
        }),
        wire.handle("plugins", "remove", async (call) => {
          const name = new Args(call).string("name");
          await plugins.registry.remove(name);
          return { result: { name } };
        }),
        wire.handle("plugins", "recheck", async () => {
          await plugins.registry.refresh();
          await plugins.recheck();
          return { result: {} };
        }),
      ];
      return () => {
        for (const off of offs.splice(0)) off();
      };
    },
    applied,
  );
}
