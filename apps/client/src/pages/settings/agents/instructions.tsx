import type { AgentForm } from "./form";
import { View } from "nsh";
import { ActionItem, ActionMenu, Field, Label, row } from "../../../components";
import { formatLocale, localizedText, uiText } from "../../../i18n";

import { useHost } from "../../../services/host";
import { EditorRow } from "./editor-row";

const agentInstructionsLimit = 10_000;
export function PersonaField(props: { form: AgentForm }) {
  const { stacked, phoneEditor, customPersona, controlHeight, persona } =
    props.form;
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
            triggerStyle={{ height: controlHeight() }}
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
          style={{ height: controlHeight(), fontSize: 12 }}
        />
      </If>
    </EditorRow>
  );
}

export function AgentInstructions(props: { form: AgentForm }) {
  const { creating, instructions, saved } = props.form;
  const instructionsHelp = () =>
    localizedText(
      "Added to the agent's context. Changes take effect when idle without interrupting active replies.",
      "添加到智能体的上下文。修改会在它空闲时生效，正在进行的回复不受影响。",
    );
  return (
    <View style={{ padding: creating ? 14 : 16, gap: 12 }}>
      <View style={{ gap: 6 }}>
        <View style={{ ...row, justifyContent: "space-between" }}>
          <Label size={12} weight={creating ? 400 : 600}>
            {uiText("instructions")}
          </Label>
          <If when={!creating || instructions().length}>
            <Label
              size={10}
              tone="muted"
            >{`${instructions().length.toLocaleString(formatLocale())} / ${agentInstructionsLimit.toLocaleString(formatLocale())}`}</Label>
          </If>
        </View>
        <If when={!creating}>
          <Label size={11} line={15} tone="muted">
            {instructionsHelp()}
          </Label>
        </If>
        <Field
          label={uiText("instructions")}
          multiline
          maxLength={Math.max(
            agentInstructionsLimit,
            saved?.instructions.length ?? 0,
          )}
          style={{
            height: creating ? 200 : 246,
            fontSize: 12,
            lineHeight: 19,
            padding: 10,
          }}
          value={instructions()}
          onChange={instructions.set}
        />
        <If when={creating}>
          <Label size={10} line={15} tone="muted">
            {instructionsHelp()}
          </Label>
        </If>
      </View>
      <If when={creating}>
        <PersonaField form={props.form} />
      </If>
    </View>
  );
}
