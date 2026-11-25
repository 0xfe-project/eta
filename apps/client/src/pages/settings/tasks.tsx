import type {
  TaskBoardSettings,
  TaskDraftTimeout,
} from "@eta/client-contracts";
import {
  TASK_DRAFT_TIMEOUT_ACTIONS,
  TASK_DRAFT_TIMEOUT_MINUTES,
} from "@eta/client-contracts";
import { signal, View } from "nsh";
import {
  ActionItem,
  ActionMenu,
  colors,
  Field,
  grow,
  Label,
  row,
} from "../../components";
import { EmptyState } from "../../components/empty-state";
import { ToggleSwitch } from "../../components/toggle-switch";
import { control, space } from "../../components/tokens";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";
import { emptyStyle, SectionHeader } from "./section";

/** The draft timeout's minutes field and its action menu. */
const minutesWidth = 72;
const actionWidth = 160;

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
  const timeout = (): TaskDraftTimeout =>
    host.section<TaskBoardSettings>("tasks", "settings")?.draftTimeout ?? {
      enabled: false,
      minutes: TASK_DRAFT_TIMEOUT_MINUTES.default,
      action: "discard",
    };
  async function saveTimeout(change: Partial<TaskDraftTimeout>) {
    if (saving()) return;
    saving.set(true);
    await host.action(() =>
      host.call("tasks", "setSettings", { draftTimeout: change }),
    );
    saving.set(false);
  }
  // The minutes field keeps what is typed until it is committed; what the host kept is shown again.
  const typed = signal<string | undefined>(undefined);
  const minutesInvalid = signal(false);
  const range = {
    min: TASK_DRAFT_TIMEOUT_MINUTES.min,
    max: TASK_DRAFT_TIMEOUT_MINUTES.max,
  };
  async function commitMinutes() {
    const text = (typed() ?? "").trim();
    typed.set(undefined);
    if (text === "") {
      minutesInvalid.set(false);
      return;
    }
    const value = Number(text);
    if (!Number.isInteger(value) || value < range.min || value > range.max) {
      minutesInvalid.set(true);
      return;
    }
    minutesInvalid.set(false);
    if (value !== timeout().minutes) await saveTimeout({ minutes: value });
  }
  const actionLabel = (action: TaskDraftTimeout["action"]) =>
    uiText(action === "accept" ? "draftTimeoutAccept" : "draftTimeoutDiscard");
  const rowStyle = {
    ...row,
    minHeight: space[40],
    gap: space[16],
    paddingHorizontal: space[16],
    paddingVertical: space[8],
    borderBottomWidth: 1,
    borderColor: c().border,
  };
  return (
    <View style={grow}>
      <If when={!host.can("tasks.setSettings")}>
        <EmptyState
          size="page"
          width="narrow"
          style={emptyStyle}
          status={host.state().ops.length ? "error" : "loading"}
          loading={uiText("loadingEllipsis")}
          error={{
            art: "tasks",
            tone: "quiet",
            title: uiText("taskSettingsUnsupported"),
            description: uiText("loadFailedUnsupported"),
          }}
          empty={{ title: uiText("taskSettingsUnsupported") }}
        />
      </If>
      <If when={host.can("tasks.setSettings")}>
        <SectionHeader title={uiText("taskFollowUp")} phone={props.phone} />
        <View
          style={{
            ...row,
            minHeight: space[40],
            gap: space[16],
            paddingHorizontal: space[16],
            paddingVertical: space[8],
            borderBottomWidth: 1,
            borderColor: c().border,
          }}
        >
          <View style={{ flex: 1, minWidth: 0, gap: space[2] }}>
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
            minHeight: space[40],
            gap: space[16],
            paddingHorizontal: space[16],
            paddingVertical: space[8],
            borderBottomWidth: 1,
            borderColor: c().border,
          }}
        >
          <View style={{ flex: 1, minWidth: 0, gap: space[2] }}>
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
        <SectionHeader title={uiText("taskDraftTimeout")} phone={props.phone} />
        <View style={rowStyle}>
          <View style={{ flex: 1, minWidth: 0, gap: space[2] }}>
            <Label>{uiText("draftTimeoutEnabled")}</Label>
            <Label variant="small" tone="muted">
              {uiText("draftTimeoutEnabledHint")}
            </Label>
          </View>
          <ToggleSwitch
            label={uiText("draftTimeoutEnabled")}
            checked={timeout().enabled}
            disabled={saving()}
            onChange={(value) => void saveTimeout({ enabled: value })}
          />
        </View>
        <View style={rowStyle}>
          <View style={{ flex: 1, minWidth: 0, gap: space[2] }}>
            <Label>{uiText("draftTimeoutMinutes")}</Label>
            <Label variant="small" tone={minutesInvalid() ? "red" : "muted"}>
              {uiText(
                minutesInvalid()
                  ? "draftTimeoutMinutesInvalid"
                  : "draftTimeoutMinutesHint",
                range,
              )}
            </Label>
          </View>
          <Field
            label={uiText("draftTimeoutMinutes")}
            value={typed() ?? String(timeout().minutes)}
            maxLength={4}
            style={{ width: minutesWidth, height: control.md }}
            onChange={(value) => typed.set(value)}
            onSubmit={() => void commitMinutes()}
            onBlur={() => void commitMinutes()}
          />
          <Label variant="small" tone="muted">
            {uiText("draftTimeoutMinutesUnit")}
          </Label>
        </View>
        <View style={rowStyle}>
          <View style={{ flex: 1, minWidth: 0, gap: space[2] }}>
            <Label>{uiText("draftTimeoutAction")}</Label>
            <Label variant="small" tone="muted">
              {uiText("draftTimeoutActionHint")}
            </Label>
          </View>
          <ActionMenu
            label={uiText("draftTimeoutAction")}
            value={actionLabel(timeout().action)}
            triggerStyle={{
              width: actionWidth,
              height: space[24],
              paddingLeft: space[12],
              paddingRight: space[8],
            }}
          >
            <Each of={[...TASK_DRAFT_TIMEOUT_ACTIONS]}>
              {(choice) => (
                <ActionItem
                  label={actionLabel(choice())}
                  checked={choice() === timeout().action}
                  onSelect={() => {
                    if (choice() !== timeout().action)
                      void saveTimeout({ action: choice() });
                  }}
                />
              )}
            </Each>
          </ActionMenu>
        </View>
      </If>
    </View>
  );
}
