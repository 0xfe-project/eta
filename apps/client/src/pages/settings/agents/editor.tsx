import type { AgentEditorProps } from "./form";
import { Scroll, signal, View } from "nsh";
import { Button, colors, grow, Label, Modal, row } from "../../../components";
import {
  BackButton,
  CloseButton,
} from "../../../components/navigation-buttons";
import { StatusDot } from "../../../components/status-dot";
import { localizedText, uiText } from "../../../i18n";

import { createAgentForm } from "./form";
import { AgentGeneral } from "./general";
import { AgentInstructions } from "./instructions";
import { AgentPlugins } from "./plugins";

const editorTabs = ["general", "instructions", "plugins"] as const;
type AgentTab = (typeof editorTabs)[number];

export function AgentEditor(props: AgentEditorProps) {
  const c = colors();
  const form = createAgentForm(props);
  const {
    canSave,
    canDelete,
    busy,
    creating,
    name,
    phoneEditor,
    close,
    save,
    remove,
    saved,
  } = form;
  const tab = signal<AgentTab>("general");
  const step = signal<1 | 2>(1);
  const deleting = signal(false);
  const title = () => saved?.name ?? localizedText("New agent", "新建智能体");
  function deleteRow() {
    return (
      <If when={canDelete()}>
        <View
          style={{
            ...row,
            justifyContent: "space-between",
            minHeight: 42,
            paddingHorizontal: 16,
            borderBottomWidth: tab() === "general" ? 1 : 0,
            borderTopWidth: tab() === "general" ? 0 : 1,
            borderColor: c().border,
          }}
        >
          <Label size={13}>{localizedText("Delete agent", "删除智能体")}</Label>
          <Button
            label={localizedText("Delete", "删除")}
            icon="archive"
            disabled={busy()}
            onPress={() => deleting.set(true)}
          />
        </View>
      </If>
    );
  }

  const tabLabel = (value: AgentTab) =>
    value === "general" ? localizedText("General", "常规") : uiText(value);
  return (
    <Modal
      title={title()}
      phone={props.phone}
      phonePage={phoneEditor()}
      width={creating ? 385 : 640}
      height={
        props.phone
          ? phoneEditor()
            ? "100%"
            : "90%"
          : creating
            ? props.tablet
              ? 600
              : 480
            : 520
      }
      modalFocus
      blurBackdrop={creating}
      hideHeader
      dismissible={!busy()}
      onClose={close}
    >
      <View
        style={{
          ...row,
          minHeight: phoneEditor() ? 45 : creating ? 44 : 40,
          gap: phoneEditor() ? 12 : 7,
          paddingHorizontal: phoneEditor() ? 16 : 11,
          borderBottomWidth: 1,
          borderColor: c().border,
        }}
      >
        <If when={phoneEditor()}>
          <BackButton disabled={busy()} onPress={close} />
        </If>
        <If when={!creating}>
          <View
            style={{
              width: 22,
              height: 22,
              alignItems: "center",
              justifyContent: "center",
              borderWidth: 1,
              borderColor: c().border,
            }}
          >
            <Label size={11} weight={600}>
              {title().slice(0, 1).toUpperCase()}
            </Label>
          </View>
        </If>
        <Label size={15} style={{ flex: 1 }} weight={500}>
          {title()}
        </Label>
        <If when={!phoneEditor()}>
          <CloseButton disabled={busy()} onPress={close} />
        </If>
      </View>
      <If
        when={creating}
        else={
          <View
            style={{ ...grow, flexDirection: props.phone ? "column" : "row" }}
          >
            <View
              style={{
                flexDirection: props.phone ? "row" : "column",
                padding: props.phone ? 0 : 5,
                gap: props.phone ? 0 : 1,
                width: props.phone ? undefined : 158,
                flexShrink: 0,
                borderRightWidth: props.phone ? 0 : 1,
                borderBottomWidth: props.phone ? 1 : 0,
                borderColor: c().border,
              }}
            >
              <Each of={editorTabs}>
                {(entry) => (
                  <Button
                    label={tabLabel(entry())}
                    selected={tab() === entry()}
                    tone="ghost"
                    size={props.phone ? 40 : 31}
                    style={
                      props.phone
                        ? {
                            flex: 1,
                            borderBottomWidth: 2,
                            borderColor:
                              tab() === entry() ? c().ink : c().border,
                            backgroundColor: c().canvas,
                          }
                        : { justifyContent: "flex-start" }
                    }
                    onPress={() => tab.set(entry())}
                  />
                )}
              </Each>
            </View>
            <View style={grow}>
              <Scroll style={grow} scrollbar={false}>
                <If when={tab() === "general"}>
                  <AgentGeneral
                    form={form}
                    onModelServices={props.onModelServices}
                  />
                  {deleteRow()}
                </If>
                <If when={tab() === "instructions"}>
                  <AgentInstructions form={form} />
                </If>
                <If when={tab() === "plugins"}>
                  <AgentPlugins form={form} />
                </If>
              </Scroll>
              <If when={tab() !== "general"}>{deleteRow()}</If>
            </View>
          </View>
        }
      >
        <View
          style={{
            ...row,
            minHeight: 40,
            gap: 10,
            paddingHorizontal: 14,
            borderBottomWidth: 1,
            borderColor: c().border,
          }}
        >
          <Label size={10} tone="muted">{`${step()}/2`}</Label>
          <Label size={12} weight={600} style={{ flex: 1 }}>
            {step() === 1
              ? localizedText("Name and model", "名称与模型")
              : uiText("instructions")}
          </Label>
          <Label size={11} tone="muted">
            {step() === 1
              ? localizedText("Next: Instructions", "下一步：指令")
              : uiText("lastStep")}
          </Label>
          <View style={{ ...row, gap: 4 }}>
            <StatusDot color={step() === 1 ? c().ink : c().faint} size={7} />
            <View
              style={{
                width: 7,
                height: 7,
                borderWidth: 1,
                borderColor: c().border,
                backgroundColor: step() === 2 ? c().ink : c().canvas,
              }}
            />
          </View>
        </View>
        <Scroll style={grow} scrollbar={false}>
          <If when={step() === 1} else={<AgentInstructions form={form} />}>
            <AgentGeneral form={form} onModelServices={props.onModelServices} />
          </If>
        </Scroll>
      </If>
      <View
        style={{
          ...row,
          paddingHorizontal: phoneEditor() ? 16 : 14,
          minHeight: phoneEditor() ? 49 : creating ? 50 : 45,
          justifyContent: "flex-end",
          gap: 8,
          borderTopWidth: 1,
          borderColor: c().border,
        }}
      >
        <Button
          label={uiText("cancel")}
          onPress={close}
          disabled={busy()}
          size={phoneEditor() ? 32 : undefined}
          style={phoneEditor() ? { minWidth: 70 } : undefined}
          tone={creating ? "ghost" : undefined}
        />
        <If when={creating && step() === 2}>
          <View style={{ flex: 1 }} />
          <Button
            label={localizedText("Previous", "上一步")}
            onPress={() => step.set(1)}
            disabled={busy()}
          />
        </If>
        <If
          when={creating && step() === 1}
          else={
            <Button
              label={
                creating ? localizedText("Create", "创建") : uiText("save")
              }
              tone="primary"
              disabled={!canSave()}
              onPress={() => void save()}
            />
          }
        >
          <Button
            label={uiText("next")}
            tone="primary"
            disabled={!name().trim()}
            onPress={() => step.set(2)}
          />
        </If>
      </View>
      <If when={deleting()}>
        <Modal
          title={localizedText("Delete agent?", "删除智能体？")}
          phone={props.phone}
          width={392}
          modalFocus
          overPhoneNavigation
          onClose={() => {
            if (!busy()) deleting.set(false);
          }}
        >
          <View style={{ padding: 16, gap: 14 }}>
            <Label>
              {localizedText(
                `Delete ${title()}? Its direct chat will be archived. Its files stay on the host.`,
                `删除${title()}？其私聊将归档，文件会留在主机上。`,
              )}
            </Label>
            <View style={{ ...row, justifyContent: "flex-end", gap: 8 }}>
              <Button
                label={uiText("cancel")}
                disabled={busy()}
                onPress={() => deleting.set(false)}
              />
              <Button
                label={localizedText("Delete", "删除")}
                disabled={busy()}
                tone="danger"
                onPress={() => void remove()}
              />
            </View>
          </View>
        </Modal>
      </If>
    </Modal>
  );
}
