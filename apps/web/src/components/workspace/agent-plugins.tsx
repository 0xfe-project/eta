import type { UseFormReturn } from "react-hook-form";
import type { AgentForm } from "./agent-form";
import { useWatch } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { usePlugins } from "@/queries/plugins";
import { PluginServers } from "./plugin-servers";

// The agent editor's 插件 page: which plugins this agent loads. Only one that can be enabled can be
// ticked; one that fell back to needing configuration stays ticked, and says its agent skips it.

export function AgentPluginsField({
  form,
  skipped,
  external,
  onOpenSettings,
}: {
  form: UseFormReturn<AgentForm>;
  /** The plugins this agent has that its sessions skip for now. */
  skipped: readonly string[];
  /** Whether it runs on an external runtime, which can start MCP servers. */
  external: boolean;
  onOpenSettings: () => void;
}) {
  const { t: translateText } = useTranslation(["agents", "plugins"] as const);
  const { plugins, loaded } = usePlugins();
  const chosen = useWatch({ control: form.control, name: "plugins" });
  const set = (name: string, on: boolean) =>
    form.setValue(
      "plugins",
      on ? [...chosen, name] : chosen.filter((item) => item !== name),
      { shouldDirty: true },
    );
  if (loaded && plugins.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        {translateText("plugins.empty")}{" "}
        <button
          type="button"
          className="underline underline-offset-2"
          onClick={onOpenSettings}
        >
          {translateText("plugins.openSettings")}
        </button>
      </p>
    );
  return (
    <ul
      aria-label={translateText("editor.tabs.plugins")}
      className="divide-y border"
    >
      {plugins.map((plugin) => {
        const checked = chosen.includes(plugin.name);
        const ready = plugin.state === "ready";
        return (
          <li key={plugin.name} className="space-y-1 px-3 py-2 text-sm">
            <label className="flex items-start gap-2">
              <Checkbox
                className="mt-0.5"
                checked={checked}
                disabled={!ready && !checked}
                onCheckedChange={(on) => set(plugin.name, on === true)}
              />
              <span className="min-w-0 flex-1 space-y-0.5">
                <span className="flex flex-wrap items-center gap-2 font-medium">
                  {plugin.name}
                  <Badge variant={ready ? "default" : "outline"}>
                    {translateText(
                      plugin.state === "ready"
                        ? "plugins:state.ready"
                        : "plugins:state.needsConfig",
                    )}
                  </Badge>
                </span>
                {plugin.description === "" ? null : (
                  <span className="block text-xs text-muted-foreground">
                    {plugin.description}
                  </span>
                )}
              </span>
            </label>
            <div className="space-y-1 pl-6">
              {skipped.includes(plugin.name) ? (
                <p className="text-xs text-destructive">
                  {translateText("plugins.skipped")}
                </p>
              ) : null}
              <PluginServers
                servers={plugin.servers}
                label={translateText("plugins:servers.title")}
              />
              {plugin.servers.length > 0 && !external ? (
                <p className="text-xs text-muted-foreground">
                  {translateText("plugins.noMcpOnEta")}
                </p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
