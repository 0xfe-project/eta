import type {
  AcpMachineList,
  BoardTaskView,
  EmailAccountView,
  MachineView,
  McpServerView,
  ProvidersView,
} from "@eta/client-contracts";
import type { IconName } from "../../components/icons";
import type { Message } from "../../i18n";
import type { AppearanceProps } from "./appearance";
import { effect } from "nsh";
import { formatLocale, uiText, useText } from "../../i18n";
import { follow, useHost } from "../../services/host";

export const sections = [
  ["Agents", "robot", "agents"],
  ["Model services", "plugsConnected", "modelServices"],
  ["Machines", "monitor", "machines"],
  ["MCP servers", "plug", "mcpServers"],
  ["External agents", "terminal", "externalAgents"],
  ["Email", "email", "email"],
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
  const email = () => host.list<EmailAccountView>("email", "accounts");
  const acp = () =>
    host.section<Record<string, AcpMachineList>>("acp", "machines") ?? {};
  const externalAgents = () =>
    Object.entries(acp()).flatMap(([machineId, value]) =>
      (value.agents ?? []).map((agent) => ({ machineId, agent })),
    );
  follow(() => "machines");
  follow(() => "mcp");
  follow(() => "acp");
  follow(() => "email");
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
  ): { text: string; tone?: "amber" | "red" } => {
    switch (name) {
      case "Agents":
        return { text: String(host.people().length) };
      case "Model services": {
        const sources = providers()?.providers ?? [];
        const count = sources.filter((source) => !source.models.length).length;
        return count
          ? {
              text: uiText("settingsNeedsAttentionCount", { count }),
              tone: "amber",
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
              tone: "amber",
            }
          : { text: String(new Set(servers.map((item) => item.server)).size) };
      }
      case "External agents":
        return { text: String(externalAgents().length) };
      case "Email": {
        const errors = email().filter((item) => item.status === "error").length;
        return errors
          ? {
              text: uiText("mailboxConnectionErrors", {
                count: errors,
                suffix: errors === 1 || formatLocale() === "zh-CN" ? "" : "s",
              }),
              tone: "red",
            }
          : { text: String(email().length) };
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

  return { providers, machines, email, externalAgents, summary };
}
