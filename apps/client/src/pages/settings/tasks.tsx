import type { TaskBoardSettings } from "@eta/client-contracts";
import { signal, View } from "nsh";
import { colors, grow, Label, row } from "../../components";
import { ToggleSwitch } from "../../components/toggle-switch";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";
import { SectionHeader } from "./section";

export function TaskSettings(props: { phone?: boolean }) {
  const host = useHost();
  const c = colors();
  const saving = signal(false);
  const reacting = () =>
    host.section<TaskBoardSettings>("tasks", "settings")?.reactToResults ===
    true;
  async function setReacting(value: boolean) {
    if (saving()) return;
    saving.set(true);
    await host.action(() =>
      host.call("tasks", "setSettings", { reactToResults: value }),
    );
    saving.set(false);
  }
  const autoAnswer = () =>
    host.section<TaskBoardSettings>("tasks", "settings")?.autoAnswerAsks ??
    false;
  async function setAutoAnswer(value: boolean) {
    if (saving()) return;
    saving.set(true);
    await host.action(() =>
      host.call("tasks", "setSettings", { autoAnswerAsks: value }),
    );
    saving.set(false);
  }
  return (
    <View style={grow}>
      <If when={host.can("tasks.setSettings")}>
        <SectionHeader title={uiText("taskFollowUp")} phone={props.phone} />
        <View
          style={{
            ...row,
            minHeight: 40,
            gap: 16,
            paddingHorizontal: 16,
            paddingVertical: 8,
            borderBottomWidth: 1,
            borderColor: c().border,
          }}
        >
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <Label>{uiText("reactToResults")}</Label>
            <Label variant="small" tone="muted">
              {uiText("reactToResultsHint")}
            </Label>
          </View>
          <ToggleSwitch
            label={uiText("reactToResults")}
            checked={reacting()}
            disabled={saving()}
            onChange={(checked) => void setReacting(checked)}
          />
        </View>
        <View
          style={{
            ...row,
            minHeight: 40,
            gap: 16,
            paddingHorizontal: 16,
            paddingVertical: 8,
            borderBottomWidth: 1,
            borderColor: c().border,
          }}
        >
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <Label>{uiText("taskAsksMakerFirst")}</Label>
            <Label variant="small" tone="muted">
              {uiText("taskAsksHint")}
            </Label>
          </View>
          <ToggleSwitch
            label={uiText("taskAsksMakerFirst")}
            checked={autoAnswer()}
            disabled={saving()}
            onChange={(value) => void setAutoAnswer(value)}
          />
        </View>
      </If>
    </View>
  );
}
