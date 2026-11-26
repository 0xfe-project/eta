import type { TextVariant } from "../../../components";
import type { AgentForm } from "./form";
import { isExternalRuntime, levelSupport } from "@eta/client-contracts";
import { View } from "nsh";
import { ActionItem, ActionMenu, Field, Label, row } from "../../../components";
import { ModelSelect } from "../../../components/model-select";
import { space } from "../../../components/tokens";
import { localizedText, uiText } from "../../../i18n";
import { RuntimeHints } from "../runtimes/runtime-hints";
import { reasonText, runtimeReason } from "../runtimes/status";
import { WarningLine } from "../section";

import { AvatarRow } from "./avatar";
import { EditorRow, focusOnOpen } from "./editor-row";
import { PersonaField } from "./instructions";
import { MachineField } from "./machine-field";

/** The name field, and the runtime menu: wide enough for a name and its reason on one line. */
const nameWidth = 200;
const runtimeMenuWidth = 260;

const agentNameLimit = 100;
export function AgentGeneral(props: {
  form: AgentForm;
  onModelServices: () => void;
  onRuntimes?: (() => void) | undefined;
}) {
  const {
    creating,
    stacked,
    phoneEditor,
    name,
    selectStyle,
    fieldStyle,
    showRunsOn,
    runtimeLabel,
    runtimeList,
    chooseRuntime,
    runtime,
    external,
    installed,
    probing,
    probeError,
    reprobe,
    model,
    chooseModel,
    thinking,
    thinkingCleared,
    levels,
    chooseThinking,
    missingModel,
    noModels,
    avatar,
  } = props.form;
  const modelWarningLink = (variant: TextVariant, tone: "ink" | "mutedInk") => {
    const label = () =>
      isExternalRuntime(runtime())
        ? uiText("runtimeSeeInSettings")
        : localizedText("Go to model services", "前往模型服务");
    return (
      <If when={!isExternalRuntime(runtime()) || props.onRuntimes}>
        <View
          role="link"
          accessibilityLabel={label()}
          onPress={() =>
            isExternalRuntime(runtime())
              ? props.onRuntimes?.()
              : props.onModelServices()
          }
          style={{ cursor: "pointer" }}
        >
          <Label
            variant={variant}
            tone={tone}
            style={
              tone === "mutedInk"
                ? { textDecorationLine: "underline" }
                : undefined
            }
          >
            {label()}
          </Label>
        </View>
      </If>
    );
  };
  function modelWarning() {
    return (
      <If when={missingModel() || noModels()}>
        <If
          when={!creating}
          else={
            // The creator's hint is one 10px line: the muted reason, then the link in ink.
            <View style={{ ...row, flexWrap: "wrap", columnGap: space[4] }}>
              <Label variant="caption" tone="muted">
                {missingModel()
                  ? localizedText(
                      "This model is no longer available. Choose another one.",
                      "该模型已不可用，请选择其他模型。",
                    )
                  : localizedText("No models available.", "暂无可用模型。")}
              </Label>
              {modelWarningLink("caption", "ink")}
            </View>
          }
        >
          <View style={{ alignItems: "flex-start", gap: space[2] }}>
            <If
              when={missingModel()}
              else={
                <Label variant="small" tone="muted">
                  {localizedText("No models available.", "暂无可用模型。")}
                </Label>
              }
            >
              <WarningLine
                outline
                text={localizedText(
                  "This model is no longer available. Choose another one.",
                  "该模型已不可用，请选择其他模型。",
                )}
              />
            </If>
            {modelWarningLink("small", "mutedInk")}
          </View>
        </If>
      </If>
    );
  }
  /**
   * What the level picker has to say: a level the last model change cleared, a kept level the
   * model does not take (warnings), else why the model offers what it does.
   */
  function thinkingHint() {
    const level = thinking();
    const warning = thinkingCleared()
      ? uiText("thinkingCleared", { level: thinkingCleared()! })
      : level && levelSupport(levels(), level) === "unsupported"
        ? uiText("thinkingUnsupported", { level })
        : undefined;
    const basis = levels().basis;
    const note =
      basis === "unknown"
        ? uiText("thinkingUnknown")
        : basis === "undeclared"
          ? uiText("thinkingUndeclared")
          : basis === "none"
            ? uiText("thinkingNone")
            : undefined;
    return (
      <If
        when={warning}
        else={
          <If when={note}>
            <Label variant={creating ? "caption" : "small"} tone="muted">
              {note}
            </Label>
          </If>
        }
      >
        <WarningLine outline text={warning!} />
      </If>
    );
  }
  /** Why a runtime cannot be picked, in a few words; its own words are under Details. */
  const reasonOf = (id: string) => {
    const info = installed()?.find((item) => item.id === id);
    const reason = info && runtimeReason(info);
    return reason ? uiText(reasonText[reason]) : undefined;
  };
  return (
    <View
      style={
        creating
          ? {
              paddingVertical: space[16],
              paddingHorizontal: space[16],
              gap: space[16],
            }
          : undefined
      }
    >
      <If when={avatar}>
        <AvatarRow draw={avatar!} stacked={stacked()} phone={phoneEditor()} />
      </If>
      <EditorRow
        label={uiText("name")}
        stack={stacked()}
        phone={phoneEditor()}
        width={nameWidth}
      >
        <Field
          label={uiText("name")}
          value={name()}
          onChange={name.set}
          placeholder={
            creating
              ? localizedText("e.g. Code review", "例如：代码审查")
              : undefined
          }
          maxLength={agentNameLimit}
          inputRef={creating ? focusOnOpen : undefined}
          style={fieldStyle()}
        />
      </EditorRow>
      <If when={showRunsOn()}>
        <MachineField form={props.form} />
      </If>
      <EditorRow
        label={uiText("runtime")}
        stack={stacked()}
        phone={phoneEditor()}
        hint={
          <RuntimeHints
            runtimes={installed()}
            chosen={external()}
            probing={probing()}
            error={probeError()}
            onRetry={() => void reprobe()}
            onRuntimes={props.onRuntimes}
          />
        }
      >
        <ActionMenu
          label={uiText("runtime")}
          value={runtimeLabel(runtime())}
          triggerStyle={selectStyle()}
          // Wide enough for a name and its reason on one line ("OpenCode  Probe timed out (30s)").
          popupWidth={runtimeMenuWidth}
        >
          <Each of={runtimeList()}>
            {(item) => (
              <ActionItem
                label={runtimeLabel(item())}
                detail={reasonOf(item())}
                // One that cannot run stays selectable only while it is the agent's own.
                disabled={!!reasonOf(item()) && runtime() !== item()}
                checked={runtime() === item()}
                onSelect={() => chooseRuntime(item())}
              />
            )}
          </Each>
        </ActionMenu>
      </EditorRow>
      <EditorRow
        label={uiText("model")}
        stack={stacked()}
        phone={phoneEditor()}
        hint={modelWarning()}
      >
        <If
          when={runtime() === "eta"}
          else={
            <If
              when={external()?.models.length}
              else={
                <Field
                  label={uiText("model")}
                  placeholder={uiText("runtimeDefault")}
                  value={model()}
                  onChange={chooseModel}
                  style={fieldStyle()}
                />
              }
            >
              <ActionMenu
                label={uiText("model")}
                value={
                  external()?.models.find(
                    (entry) => `${runtime()}:${entry.id}` === model(),
                  )?.name ||
                  model() ||
                  uiText("runtimeDefault")
                }
                triggerStyle={selectStyle()}
              >
                <ActionItem
                  label={uiText("runtimeDefault")}
                  checked={!model()}
                  onSelect={() => chooseModel("")}
                />
                <Each of={external()?.models ?? []} key={(entry) => entry.id}>
                  {(entry) => (
                    <ActionItem
                      label={entry().name}
                      checked={`${runtime()}:${entry().id}` === model()}
                      onSelect={() => chooseModel(`${runtime()}:${entry().id}`)}
                    />
                  )}
                </Each>
              </ActionMenu>
            </If>
          }
        >
          <ModelSelect
            value={model()}
            onChange={chooseModel}
            triggerStyle={selectStyle()}
          />
        </If>
      </EditorRow>
      <EditorRow
        label={uiText("thinkingLevel")}
        stack={stacked()}
        phone={phoneEditor()}
        hint={thinkingHint()}
      >
        <ActionMenu
          label={uiText("thinkingLevel")}
          value={thinking() ?? uiText("modelDefault")}
          triggerStyle={selectStyle()}
        >
          <ActionItem
            label={uiText("modelDefault")}
            checked={!thinking()}
            onSelect={() => chooseThinking(null)}
          />
          <Each of={levels().levels}>
            {(option) => (
              <ActionItem
                label={option()}
                checked={thinking() === option()}
                onSelect={() => chooseThinking(option())}
              />
            )}
          </Each>
        </ActionMenu>
      </EditorRow>
      <If when={!creating && !isExternalRuntime(runtime())}>
        <PersonaField form={props.form} />
      </If>
    </View>
  );
}
