import type { SettingsSection } from "./workspace-store";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { LanguageSettings } from "@/components/language-settings";
import { Switch } from "@/components/ui/switch";
import { useTheme } from "@/components/use-theme";
import { elementPickerDefault, setElementPicker } from "@/lib/element-picker";
import { translate } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useGitHubMounted } from "@/queries/github";
import { AgentSettings } from "./agent-settings";
import { ApprovalSettings } from "./approval-settings";
import { ConnectionSettings } from "./connection-settings";
import { EmailSettings } from "./email-settings";
import { ArchivedGroups } from "./groups";
import { MachineSettings } from "./machine-settings";
import { McpSettings } from "./mcp-settings";
import { ProviderSettings } from "./provider-settings";
import { SettingsNav } from "./settings-nav";
import { settingsSections, useSettingsAttention } from "./settings-sections";
import { useWorkspaceStore } from "./workspace-store";

// Settings' body: the rail of sections beside the one being edited. The same body is a dialog
// over whatever is on screen on a wide window and a page of its own on a phone, so the list, its
// hiding rules and the panels themselves are written once, here.

/**
 * The sections the rail does not offer, by choice: 连接 is off in this build, and 审批 is the
 * editor's only. The settings stay in force — `?settings=connections` still opens one — because
 * hiding the door is not the same as turning the feature off.
 */
const hiddenSettings = new Set<SettingsSection>(["approvals", "connections"]);

const colorModes = [
  {
    value: "system",
    get label() {
      return translate("settings:appearance.system");
    },
  },
  {
    value: "light",
    get label() {
      return translate("settings:appearance.light");
    },
  },
  {
    value: "dark",
    get label() {
      return translate("settings:appearance.dark");
    },
  },
] as const;

const chatWidths = [
  {
    value: "extra-narrow",
    get label() {
      return translate("settings:appearance.chatWidthExtraNarrow");
    },
  },
  {
    value: "narrow",
    get label() {
      return translate("settings:appearance.chatWidthNarrow");
    },
  },
  {
    value: "standard",
    get label() {
      return translate("settings:appearance.chatWidthStandard");
    },
  },
  {
    value: "full",
    get label() {
      return translate("settings:appearance.chatWidthFull");
    },
  },
] as const;

function AppearanceSettings() {
  const { t: translateText } = useTranslation(["settings", "common"] as const);
  const workspace = useWorkspaceStore((s) => s.workspace);
  const setWorkspace = useWorkspaceStore((s) => s.setWorkspace);
  const { theme, setTheme } = useTheme();
  const colorModeLabelId = useId();
  const chatWidthLabelId = useId();
  return (
    <div>
      <div className="settings-heading">
        <h2>{translateText("sections.appearance")}</h2>
      </div>
      {/* Rows, not cards: a label on the left, its control on the right, one decision per line. */}
      <div className="settings-row">
        <div className="settings-row-label">
          <div id={colorModeLabelId}>
            {translateText("appearance.colorMode")}
          </div>
        </div>
        <div
          className="settings-control settings-inline"
          role="group"
          aria-labelledby={colorModeLabelId}
        >
          {colorModes.map((choice) => (
            <button
              key={choice.value}
              type="button"
              aria-pressed={theme === choice.value}
              onClick={() => setTheme(choice.value)}
            >
              {choice.label}
            </button>
          ))}
        </div>
      </div>
      <div className="settings-row">
        <div className="settings-row-label">
          <label htmlFor="language">
            {translateText("appearance.language")}
          </label>
        </div>
        <div className="settings-control">
          <LanguageSettings />
        </div>
      </div>
      <div className="settings-row">
        <div className="settings-row-label">
          <div id={chatWidthLabelId}>
            {translateText("appearance.chatWidth")}
          </div>
          <p>{translateText("appearance.chatWidthHint")}</p>
        </div>
        <div
          className="settings-control settings-inline"
          role="group"
          aria-labelledby={chatWidthLabelId}
        >
          {chatWidths.map((choice) => (
            <button
              key={choice.value}
              type="button"
              aria-pressed={
                (workspace.chatWidth ?? "standard") === choice.value
              }
              onClick={() =>
                setWorkspace((state) => ({
                  ...state,
                  chatWidth: choice.value,
                }))
              }
            >
              {choice.label}
            </button>
          ))}
        </div>
      </div>
      <div className="settings-row">
        <div className="settings-row-label">
          <div>{translateText("appearance.transcriptRail")}</div>
          <p>{translateText("appearance.transcriptRailHint")}</p>
        </div>
        <div className="settings-control">
          <Switch
            id="transcript-rail"
            aria-label={translateText("appearance.transcriptRail")}
            checked={workspace.transcriptRail ?? false}
            onCheckedChange={(transcriptRail) =>
              setWorkspace((state) => ({ ...state, transcriptRail }))
            }
          />
        </div>
      </div>
      <div className="settings-row">
        <div className="settings-row-label">
          <div>{translateText("appearance.elementPicker")}</div>
          <p>{translateText("appearance.elementPickerHint")}</p>
        </div>
        <div className="settings-control">
          <Switch
            id="react-grab"
            aria-label={translateText("appearance.elementPicker")}
            checked={workspace.reactGrab ?? elementPickerDefault()}
            onCheckedChange={(reactGrab) => {
              setWorkspace((state) => ({ ...state, reactGrab }));
              void setElementPicker(reactGrab);
            }}
          />
        </div>
      </div>
    </div>
  );
}

/** The panel a section opens: one settings page, or the appearance one by default. */
function SectionContent({
  section,
  githubMounted,
}: {
  section: SettingsSection;
  githubMounted: boolean;
}) {
  return section === "agents" ? (
    <AgentSettings />
  ) : section === "providers" ? (
    <ProviderSettings />
  ) : section === "approvals" ? (
    <ApprovalSettings />
  ) : section === "machines" ? (
    <MachineSettings />
  ) : section === "connections" && githubMounted ? (
    <ConnectionSettings />
  ) : section === "mcp" ? (
    <McpSettings />
  ) : section === "email" ? (
    <EmailSettings />
  ) : section === "archived" ? (
    <ArchivedGroups />
  ) : (
    <AppearanceSettings />
  );
}

export function SettingsPanels({
  value,
  onChange,
  className,
}: {
  value: SettingsSection;
  onChange: (section: SettingsSection) => void;
  className?: string;
}) {
  const { t: translateText } = useTranslation(["settings", "common"] as const);
  const attention = useSettingsAttention();
  const githubMounted = useGitHubMounted();
  return (
    <div className={cn("settings-layout", className)}>
      <SettingsNav
        label={translateText("accessibility.sections")}
        sections={settingsSections
          .filter((section) => !hiddenSettings.has(section.value))
          .map((section) => ({
            ...section,
            attention: attention[section.value],
            hint: translateText("accessibility.accountsNeedAttention"),
          }))}
        value={value}
        onChange={onChange}
      />
      <section className="settings-content">
        <SectionContent section={value} githubMounted={githubMounted} />
      </section>
    </div>
  );
}
