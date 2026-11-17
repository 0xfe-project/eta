import type { SettingsSection } from "./workspace-store";
import { lazy, Suspense, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { LanguageSettings } from "@/components/language-settings";
import { Loading } from "@/components/states";
import { Switch } from "@/components/ui/switch";
import { useTheme } from "@/components/use-theme";
import { customFontMaxLength, normalizeCustomFont } from "@/lib/custom-font";
import { elementPickerDefault, setElementPicker } from "@/lib/element-picker";
import { translate } from "@/lib/i18n";
import { host } from "@/lib/native";
import { cn } from "@/lib/utils";
import { AcpSettings } from "./acp-settings";
import { AgentSettings } from "./agent-settings";
import { ApprovalSettings } from "./approval-settings";
import { EmailSettings } from "./email-settings";
import { ArchivedGroups } from "./groups";
import { HostSettings } from "./host-settings";
import { MachineSettings } from "./machine-settings";
import { McpSettings } from "./mcp-settings";
import { ProviderSettings } from "./provider-settings";
import { SettingsNav } from "./settings-nav";
import { settingsSections, useSettingsAttention } from "./settings-sections";
import { TaskArchiveSetting } from "./task-archive";
import { UpdateSettings } from "./update-settings";
import { useWorkspaceStore } from "./workspace-store";

// Settings' body: the rail of sections beside the one being edited. The same body is a dialog
// over whatever is on screen on a wide window and a page of its own on a phone, so the list, its
// hiding rules and the panels themselves are written once, here.

// Apart from the main chunk: its form carries the regular-expression engine fields are checked with.
const PluginSettings = lazy(async () => ({
  default: (await import("./plugin-settings")).PluginSettings,
}));

/**
 * The sections the rail does not offer, by choice: Approvals is the editor's only. The settings stay
 * in force — `?settings=approvals` still opens them — because hiding the door is not the same as
 * turning the feature off.
 */
const hiddenSettings = new Set<SettingsSection>(["approvals"]);

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

/**
 * A font field — the interface font or the mono one: a name typed in, saved when the field is left
 * or Enter is pressed. A name the check refuses stays in the field with the reason under the label
 * and is not saved.
 */
function CustomFontSetting({
  field,
}: {
  field: "customFont" | "customMonoFont";
}) {
  const { t: translateText } = useTranslation(["settings"] as const);
  const saved = useWorkspaceStore((s) => s.workspace[field] ?? "");
  const setWorkspace = useWorkspaceStore((s) => s.setWorkspace);
  const [draft, setDraft] = useState(saved);
  const [invalid, setInvalid] = useState(false);
  const inputId = useId();
  const errorId = useId();
  const commit = () => {
    const name = normalizeCustomFont(draft);
    if (name === null) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setDraft(name);
    if (name === saved) return;
    setWorkspace((state) => {
      const { [field]: _previous, ...rest } = state;
      return name === "" ? rest : { ...rest, [field]: name };
    });
  };
  const text =
    field === "customFont"
      ? {
          label: translateText("appearance.customFont"),
          hint: translateText("appearance.customFontHint"),
          placeholder: "Eta Sans",
        }
      : {
          label: translateText("appearance.customMonoFont"),
          hint: translateText("appearance.customMonoFontHint"),
          placeholder: translateText("appearance.customMonoFontPlaceholder"),
        };
  return (
    <div className="settings-row">
      <div className="settings-row-label">
        <label htmlFor={inputId}>{text.label}</label>
        {invalid ? (
          <p id={errorId} role="alert" className="!text-destructive">
            {translateText("appearance.customFontInvalid")}
          </p>
        ) : (
          <p>{text.hint}</p>
        )}
      </div>
      <div className="settings-control">
        <input
          id={inputId}
          type="text"
          value={draft}
          maxLength={customFontMaxLength * 2}
          spellCheck={false}
          autoComplete="off"
          placeholder={text.placeholder}
          aria-invalid={invalid}
          aria-describedby={invalid ? errorId : undefined}
          onChange={(event) => {
            setDraft(event.target.value);
            if (invalid) setInvalid(false);
          }}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit();
          }}
        />
      </div>
    </div>
  );
}

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
      <CustomFontSetting field="customFont" />
      <CustomFontSetting field="customMonoFont" />
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
function SectionContent({ section }: { section: SettingsSection }) {
  return section === "agents" ? (
    <AgentSettings />
  ) : section === "providers" ? (
    <ProviderSettings />
  ) : section === "approvals" ? (
    <ApprovalSettings />
  ) : section === "machines" ? (
    <MachineSettings />
  ) : section === "mcp" ? (
    <McpSettings />
  ) : section === "acp" ? (
    <AcpSettings />
  ) : section === "plugins" ? (
    <Suspense fallback={<Loading rows={3} />}>
      <PluginSettings />
    </Suspense>
  ) : section === "email" ? (
    <EmailSettings />
  ) : section === "archived" ? (
    <>
      <TaskArchiveSetting />
      <ArchivedGroups />
    </>
  ) : section === "host" ? (
    <HostSettings />
  ) : section === "update" ? (
    <UpdateSettings />
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
  return (
    <div className={cn("settings-layout", className)}>
      <SettingsNav
        label={translateText("accessibility.sections")}
        sections={settingsSections
          .filter((section) => !hiddenSettings.has(section.value))
          // Only the shell can change where its host is.
          .filter(
            (section) =>
              section.value !== "host" || host().connection !== undefined,
          )
          .map((section) => ({
            ...section,
            attention: attention[section.value],
            hint: translateText("accessibility.accountsNeedAttention"),
          }))}
        value={value}
        onChange={onChange}
      />
      <section className="settings-content">
        <SectionContent section={value} />
      </section>
    </div>
  );
}
