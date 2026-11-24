import type {
  AcpMachineList,
  BoardTaskView,
  MachineView,
  McpServerView,
  ProvidersView,
} from "@eta/client-contracts";
import type { IconName } from "../../components/icons";
import type { Message } from "../../i18n";
import type { AppearanceProps } from "./appearance";
import { effect } from "nsh";
import { uiText, useText } from "../../i18n";
import { follow, useHost } from "../../services/host";
import { createRuntimeListing } from "./runtimes/listing";

export const sections = [
  ["Agents", "robot", "agents"],
  ["Model services", "plugsConnected", "modelServices"],
  ["Machines", "monitor", "machines"],
  ["MCP servers", "plug", "mcpServers"],
  ["Plugins", "plugins", "plugins"],
  ["External agents", "terminal", "externalAgents"],
  ["Tasks", "tasks", "tasks"],
  ["Runtimes", "cpu", "runtimes"],
  ["Network", "globe", "network"],
  ["Archived", "archive", "archived"],
  ["Appearance", "palette", "appearance"],
  ["Update", "arrowCircleUp", "update"],
] as const satisfies readonly (readonly [string, IconName, Message])[];

export type SettingsSection = (typeof sections)[number][0];

export function useSettingsOverview(theme: () => AppearanceProps["theme"]) {
  const host = useHost();
  const text = useText();
  const providers = () => host.section<ProvidersView>("providers", "config");
  const machines = () => host.list<MachineView>("machines");
  const acp = () =>
    host.section<Record<string, AcpMachineList>>("acp", "machines") ?? {};
  const externalAgents = () =>
    Object.entries(acp()).flatMap(([machineId, value]) =>
      (value.agents ?? []).map((agent) => ({ machineId, agent })),
    );
  follow(() => "machines");
  follow(() => "mcp");
  follow(() => "acp");
  // A daemon's external agents are in the `acp` section only once it was asked while online:
  // ask each online daemon once, and again after it was offline.
  const askedAcp = new Set<string>();
  effect(() => {
    if (host.state().status !== "open" || !host.can("acp.refresh")) return;
    for (const machine of machines()) {
      if (machine.kind !== "daemon") continue;
      if (machine.status !== "online") {
        askedAcp.delete(machine.id);
        continue;
      }
      if (askedAcp.has(machine.id)) continue;
      askedAcp.add(machine.id);
      void host
        .call("acp", "refresh", { machineId: machine.id })
        .catch(() => askedAcp.delete(machine.id));
    }
  });
  const runtimes = createRuntimeListing();
  // The Update row says which build runs, so read it once the host allows
  // it rather than waiting for the Update pane to be opened.
  let checking = false;
  effect(() => {
    if (
      checking ||
      host.upgradeCheck() ||
      host.state().status !== "open" ||
      !host.can("upgrade.check")
    )
      return;
    checking = true;
    void host.checkUpgrade().catch(() => {
      checking = false;
    });
  });
  const summary = (
    name: SettingsSection,
  ): { text: string; tone?: "warning" | "red" } => {
    switch (name) {
      case "Agents":
        return { text: String(host.people().length) };
      case "Model services": {
        const sources = providers()?.providers ?? [];
        const count = sources.filter((source) => !source.models.length).length;
        return count
          ? {
              text: uiText("settingsNeedsAttentionCount", { count }),
              tone: "warning",
            }
          : { text: String(sources.length) };
      }
      case "Machines":
        return {
          text: uiText("machinesOnlineCount", {
            count: machines().filter((item) => item.status === "online").length,
          }),
        };
      case "MCP servers": {
        const servers = host.list<McpServerView>("mcp");
        const needsLogin = new Set(
          servers
            .filter((item) => item.auth === "needs_login")
            .map((item) => item.server),
        ).size;
        return needsLogin
          ? {
              text: uiText("settingsNeedsSignInCount", { count: needsLogin }),
              tone: "warning",
            }
          : { text: String(new Set(servers.map((item) => item.server)).size) };
      }
      case "Plugins":
        return { text: "" };
      case "External agents":
        return { text: String(externalAgents().length) };
      case "Tasks":
        return { text: "" };
      case "Runtimes":
        return {
          text: uiText("runtimesAvailableCount", {
            count: runtimes.available(),
          }),
        };
      case "Network": {
        const open = providers()?.privateNetwork;
        const invalid = open?.invalid.length ?? 0;
        if (invalid)
          return {
            text: uiText("settingsNeedsAttentionCount", { count: invalid }),
            tone: "warning",
          };
        return {
          text: [
            String(open?.allow.length ?? 0),
            ...(open?.loopback ? ["localhost"] : []),
          ].join(" · "),
        };
      }
      case "Archived":
        return {
          text: String(
            host.conversations().filter((item) => item.archived).length +
              host.list<BoardTaskView>("tasks", "archived").length,
          ),
        };
      case "Appearance":
        return {
          text: text(theme()),
        };
      case "Update": {
        const check = host.upgradeCheck();
        if (!check) return { text: "" };
        return {
          text:
            check.available && check.latest
              ? uiText("settingsUpdateAvailable", {
                  version: check.version,
                  latest: check.latest,
                })
              : uiText("settingsUpdateUpToDate", { version: check.version }),
        };
      }
    }
  };

  return { providers, machines, externalAgents, runtimes, summary };
}
