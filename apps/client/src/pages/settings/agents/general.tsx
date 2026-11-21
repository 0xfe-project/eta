import type { ThinkingLevel } from "@eta/client-contracts";
import type { TextVariant } from "../../../components";
import type { AgentForm } from "./form";
import { View } from "nsh";
import { ActionItem, ActionMenu, Field, Label, row } from "../../../components";
import { ModelSelect } from "../../../components/model-select";
import { localizedText, uiText } from "../../../i18n";
import { WarningLine } from "../section";

import { AvatarRow } from "./avatar";
import { EditorRow, focusOnOpen } from "./editor-row";
import { PersonaField } from "./instructions";
import { MachineField } from "./machine-field";

const agentNameLimit = 100;
const thinkingOptions: ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];
export function AgentGeneral(props: {
  form: AgentForm;
  onModelServices: () => void;
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
    model,
    chooseModel,
    thinking,
    missingModel,
    noModels,
    avatar,
  } = props.form;
  const goToModelServices = (
    variant: TextVariant,
    tone: "ink" | "mutedInk",
  ) => (
    <View
      role="link"
      accessibilityLabel={localizedText("Go to model services", "前往模型服务")}
      onPress={props.onModelServices}
      style={{ cursor: "pointer" }}
    >
      <Label
        variant={variant}
        tone={tone}
        style={
          tone === "mutedInk" ? { textDecorationLine: "underline" } : undefined
        }
      >
        {localizedText("Go to model services", "前往模型服务")}
      </Label>
    </View>
  );
  function modelWarning() {
    return (
      <If when={missingModel() || noModels()}>
        <If
          when={!creating}
          else={
            // The creator's hint is one 10px line: the muted reason, then the link in ink.
            <View style={{ ...row, flexWrap: "wrap", columnGap: 6 }}>
              <Label variant="caption" tone="muted">
                {missingModel()
                  ? localizedText(
                      "This model is no longer available. Choose another one.",
                      "该模型已不可用，请选择其他模型。",
                    )
                  : localizedText("No models available.", "暂无可用模型。")}
              </Label>
              {goToModelServices("caption", "ink")}
            </View>
          }
        >
          <View style={{ alignItems: "flex-start", gap: 2 }}>
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
            {goToModelServices("small", "mutedInk")}
          </View>
        </If>
      </If>
    );
  }
  return (
    <View
      style={
        creating
          ? { paddingVertical: 16, paddingHorizontal: 14, gap: 16 }
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
        width={200}
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
      >
        <ActionMenu
          label={uiText("runtime")}
          value={runtimeLabel(runtime())}
          triggerStyle={selectStyle()}
        >
          <Each of={runtimeList()}>
            {(item) => (
              <ActionItem
                label={runtimeLabel(item())}
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
          <ModelSelect value={model()} onChange={chooseModel} />
        </If>
      </EditorRow>
      <EditorRow
        label={uiText("thinkingLevel")}
        stack={stacked()}
        phone={phoneEditor()}
      >
        <ActionMenu
          label={uiText("thinkingLevel")}
          value={thinking() ?? uiText("modelDefault")}
          triggerStyle={selectStyle()}
        >
          <ActionItem
            label={uiText("modelDefault")}
            checked={!thinking()}
            onSelect={() => thinking.set(null)}
          />
          <Each of={thinkingOptions}>
            {(option) => (
              <ActionItem
                label={option()}
                checked={thinking() === option()}
                onSelect={() => thinking.set(option())}
              />
            )}
          </Each>
        </ActionMenu>
      </EditorRow>
      <If when={!creating}>
        <PersonaField form={props.form} />
      </If>
    </View>
  );
}
