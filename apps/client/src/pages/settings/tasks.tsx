import type {
  TaskBoardSettings,
  TaskDraftTimeout,
} from "@eta/client-contracts";
import {
  TASK_DRAFT_TIMEOUT_ACTIONS,
  TASK_DRAFT_TIMEOUT_MINUTES,
  TASK_REVIEW_MAX_ROUNDS,
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

/** A whole-number field that keeps what is typed until submitted or blurred, then falls back to host state. */
function boundedIntField(options: {
  range: { min: number; max: number };
  current: () => number;
  onCommit: (value: number) => Promise<void>;
}) {
  const typed = signal<string | undefined>(undefined);
  const invalid = signal(false);
  async function commit() {
    const text = (typed() ?? "").trim();
    typed.set(undefined);
    if (text === "") {
      invalid.set(false);
      return;
    }
    const value = Number(text);
    if (
      !Number.isInteger(value) ||
      value < options.range.min ||
      value > options.range.max
    ) {
      invalid.set(true);
      return;
    }
    invalid.set(false);
    if (value !== options.current()) await options.onCommit(value);
  }
  return {
    invalid,
    value: () => typed() ?? String(options.current()),
    onChange: (value: string) => typed.set(value),
    commit,
  };
}

export function TaskSettings(props: { phone?: boolean }) {
  const host = useHost();
  const c = colors();
  const savingCount = signal(0);
  const saving = () => savingCount() > 0;
  let saveQueue = Promise.resolve();
  // Serialize updates rather than dropping concurrent calls (e.g. a field blur racing a toggle press).
  function saveSettings(change: Partial<TaskBoardSettings>) {
    savingCount.set(savingCount() + 1);
    const next = saveQueue.then(async () => {
      try {
        await host.action(() => host.call("tasks", "setSettings", change));
      } finally {
        savingCount.set(savingCount() - 1);
      }
    });
    saveQueue = next;
    return next;
  }
  const reacting = () =>
    host.section<TaskBoardSettings>("tasks", "settings")?.reactToResults ===
    true;
  const reviewMaxRounds = () =>
    host.section<TaskBoardSettings>("tasks", "settings")?.reviewMaxRounds ??
    TASK_REVIEW_MAX_ROUNDS.default;
  const reviewRange = {
    min: TASK_REVIEW_MAX_ROUNDS.min,
    max: TASK_REVIEW_MAX_ROUNDS.max,
  };
  const reviewRounds = boundedIntField({
    range: reviewRange,
    current: reviewMaxRounds,
    onCommit: (value) => saveSettings({ reviewMaxRounds: value }),
  });
  const autoAnswer = () =>
    host.section<TaskBoardSettings>("tasks", "settings")?.autoAnswerAsks ??
    false;
  const timeout = (): TaskDraftTimeout =>
    host.section<TaskBoardSettings>("tasks", "settings")?.draftTimeout ?? {
      enabled: false,
      minutes: TASK_DRAFT_TIMEOUT_MINUTES.default,
      action: "discard",
    };
  async function saveTimeout(change: Partial<TaskDraftTimeout>) {
    await saveSettings({ draftTimeout: change as TaskDraftTimeout });
  }
  const range = {
    min: TASK_DRAFT_TIMEOUT_MINUTES.min,
    max: TASK_DRAFT_TIMEOUT_MINUTES.max,
  };
  const minutes = boundedIntField({
    range,
    current: () => timeout().minutes,
    onCommit: (value) => saveTimeout({ minutes: value }),
  });
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
        <View style={rowStyle}>
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
            onChange={(checked) =>
              void saveSettings({ reactToResults: checked })
            }
          />
        </View>
        <View style={rowStyle}>
          <View style={{ flex: 1, minWidth: 0, gap: space[2] }}>
            <Label>{uiText("reviewMaxRounds")}</Label>
            <Label
              variant="small"
              tone={reviewRounds.invalid() ? "red" : "muted"}
            >
              {uiText(
                reviewRounds.invalid()
                  ? "reviewMaxRoundsInvalid"
                  : "reviewMaxRoundsHint",
                reviewRange,
              )}
            </Label>
          </View>
          <Field
            label={uiText("reviewMaxRounds")}
            value={reviewRounds.value()}
            maxLength={4}
            style={{ width: minutesWidth, height: control.md }}
            onChange={reviewRounds.onChange}
            onSubmit={() => void reviewRounds.commit()}
            onBlur={() => void reviewRounds.commit()}
          />
          <Label variant="small" tone="muted">
            {uiText("reviewMaxRoundsUnit")}
          </Label>
        </View>
        <View style={rowStyle}>
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
            onChange={(value) => void saveSettings({ autoAnswerAsks: value })}
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
            <Label variant="small" tone={minutes.invalid() ? "red" : "muted"}>
              {uiText(
                minutes.invalid()
                  ? "draftTimeoutMinutesInvalid"
                  : "draftTimeoutMinutesHint",
                range,
              )}
            </Label>
          </View>
          <Field
            label={uiText("draftTimeoutMinutes")}
            value={minutes.value()}
            maxLength={4}
            style={{ width: minutesWidth, height: control.md }}
            onChange={minutes.onChange}
            onSubmit={() => void minutes.commit()}
            onBlur={() => void minutes.commit()}
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
