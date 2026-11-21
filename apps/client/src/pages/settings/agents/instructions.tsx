import type { AgentForm } from "./form";
import { View } from "nsh";
import {
  ActionItem,
  ActionMenu,
  colors,
  Field,
  Label,
  row,
  textFaces,
  textStyle,
} from "../../../components";
import { formatLocale, localizedText, uiText } from "../../../i18n";

import { useHost } from "../../../services/host";
import { SectionHeader } from "../section";
import { EditorRow, focusOnOpen } from "./editor-row";

const agentInstructionsLimit = 10_000;
export function PersonaField(props: { form: AgentForm }) {
  const {
    stacked,
    phoneEditor,
    customPersona,
    selectStyle,
    fieldStyle,
    persona,
  } = props.form;
  const personaDefault = () =>
    localizedText("Project default", "使用项目默认人设");
  const host = useHost();
  const cards = () =>
    host.list<{ id: string; name: string; description: string }>(
      "personas",
      "cards",
    );
  return (
    <EditorRow
      label={uiText("persona")}
      stack={stacked()}
      phone={phoneEditor()}
    >
      <If
        when={customPersona()}
        else={
          <ActionMenu
            label={uiText("persona")}
            value={
              cards().find((item) => item.id === persona())?.name ??
              (persona() || personaDefault())
            }
            triggerStyle={selectStyle()}
          >
            <ActionItem
              label={personaDefault()}
              checked={!persona()}
              onSelect={() => persona.set("")}
            />
            <Each of={cards()} key={(entry) => entry.id}>
              {(entry) => (
                <ActionItem
                  label={entry().name}
                  checked={persona() === entry().id}
                  onSelect={() => persona.set(entry().id)}
                />
              )}
            </Each>
            <ActionItem
              label={localizedText("Custom name…", "输入自定义名称…")}
              onSelect={() => customPersona.set(true)}
            />
          </ActionMenu>
        }
      >
        <Field
          label={uiText("persona")}
          placeholder={personaDefault()}
          value={persona()}
          onChange={persona.set}
          onSubmit={() => customPersona.set(false)}
          style={fieldStyle()}
        />
      </If>
    </EditorRow>
  );
}

export function AgentInstructions(props: { form: AgentForm }) {
  const { creating, instructions, saved, phoneEditor } = props.form;
  const c = colors();
  const type = textFaces();
  const limit = () =>
    Math.max(agentInstructionsLimit, saved?.instructions.length ?? 0);
  const count = () =>
    `${instructions().length.toLocaleString(formatLocale())} / ${agentInstructionsLimit.toLocaleString(formatLocale())}`;
  const instructionsHelp = () =>
    localizedText(
      "Added to the agent's context. Changes take effect when idle, without interrupting active replies.",
      "添加到智能体的上下文。修改会在它空闲时生效，正在进行的回复不受影响。",
    );
  return (
    <If
      when={creating}
      else={
        <If
          when={phoneEditor()}
          else={
            <View>
              <SectionHeader
                title={uiText("instructions")}
                description={instructionsHelp()}
              >
                <Label variant="small" tone="muted">
                  {count()}
                </Label>
              </SectionHeader>
              <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
                <Field
                  label={uiText("instructions")}
                  multiline
                  maxLength={limit()}
                  style={{
                    height: 250,
                    ...textStyle(type("small"), "prose"),
                    padding: 10,
                    borderColor: c().strong,
                  }}
                  value={instructions()}
                  onChange={instructions.set}
                />
              </View>
            </View>
          }
        >
          <View
            style={{
              gap: 8,
              paddingHorizontal: 16,
              paddingVertical: 8,
              borderBottomWidth: 1,
              borderColor: c().border,
            }}
          >
            <View style={{ ...row, justifyContent: "space-between" }}>
              <Label>{uiText("instructions")}</Label>
              <If when={instructions().length}>
                <Label variant="small" tone="muted">
                  {count()}
                </Label>
              </If>
            </View>
            <Field
              label={uiText("instructions")}
              multiline
              maxLength={limit()}
              style={{
                height: 240,
                ...textStyle(type("small"), "prose"),
                padding: 12,
                borderColor: c().strong,
              }}
              value={instructions()}
              onChange={instructions.set}
            />
            <Label variant="small" tone="muted">
              {instructionsHelp()}
            </Label>
          </View>
        </If>
      }
    >
      <View style={{ paddingVertical: 16, paddingHorizontal: 14, gap: 16 }}>
        <View style={{ gap: 6 }}>
          <View style={{ ...row, justifyContent: "space-between" }}>
            <Label variant="caption">{uiText("instructions")}</Label>
            <If when={instructions().length}>
              <Label variant="caption" tone="muted">
                {count()}
              </Label>
            </If>
          </View>
          <Field
            label={uiText("instructions")}
            multiline
            maxLength={limit()}
            inputRef={focusOnOpen}
            style={{
              height: 192,
              ...textStyle(type("caption"), "prose"),
              padding: 9,
            }}
            value={instructions()}
            onChange={instructions.set}
          />
          <Label variant="caption" tone="muted">
            {instructionsHelp()}
          </Label>
        </View>
        <PersonaField form={props.form} />
      </View>
    </If>
  );
}
