import type { AgentEditorProps } from "./form";
import { Scroll, signal, View } from "nsh";
import { Button, colors, grow, Label, Modal, row } from "../../../components";
import { AgentFace } from "../../../components/agent-face";
import {
  BackButton,
  CloseButton,
} from "../../../components/navigation-buttons";

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
  /** Wide editors pin the row under the Instructions and Plugins tabs; the phone lists it after them. */
  const pinned = () => !props.phone && tab() !== "general";
  function deleteRow() {
    return (
      <If when={canDelete()}>
        <View
          style={{
            ...row,
            minHeight: props.phone ? 44 : 40,
            gap: 16,
            paddingHorizontal: 16,
            paddingVertical: 8,
            borderBottomWidth: pinned() ? 0 : 1,
            borderTopWidth: pinned() ? 1 : 0,
            borderColor: c().border,
          }}
        >
          <Label line={20} style={{ flex: 1 }}>
            {localizedText("Delete agent", "删除智能体")}
          </Label>
          <Button
            label={localizedText("Delete", "删除")}
            icon="trash"
            disabled={busy()}
            size={props.phone ? 28 : undefined}
            style={{ gap: 6, paddingHorizontal: 10 }}
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
            ? undefined
            : 520
      }
      modalFocus
      blurBackdrop={creating && !props.tablet}
      hideHeader
      dismissible={!busy()}
      onClose={close}
    >
      <View
        style={{
          ...row,
          minHeight: phoneEditor() ? 48 : creating ? 46 : 40,
          gap: phoneEditor() ? 4 : 10,
          paddingLeft: phoneEditor() ? 8 : creating ? 10 : 11,
          paddingRight: phoneEditor() ? 8 : creating ? 9 : 11,
          borderBottomWidth: 1,
          borderColor: c().border,
        }}
      >
        <If when={phoneEditor()}>
          <BackButton
            disabled={busy()}
            size={40}
            iconSize={16}
            onPress={close}
          />
        </If>
        <View
          style={{ ...row, flex: 1, minWidth: 0, gap: phoneEditor() ? 8 : 10 }}
        >
          <If when={!creating}>
            <AgentFace id={props.id} size={24} />
          </If>
          <If
            when={phoneEditor()}
            else={
              <Label
                size={creating ? 14 : 16}
                line={creating ? 18 : 22}
                style={{ flex: 1 }}
                weight={500}
              >
                {title()}
              </Label>
            }
          >
            <Label line={20} weight={600} lines={1} style={{ flex: 1 }}>
              {title()}
            </Label>
          </If>
        </View>
        <If
          when={!phoneEditor()}
          else={<View style={{ width: 40, height: 40, flexShrink: 0 }} />}
        >
          <CloseButton
            disabled={busy()}
            size={creating ? 24 : 16}
            iconSize={creating ? 14 : 16}
            style={creating ? undefined : { paddingHorizontal: 0 }}
            onPress={close}
          />
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
                padding: props.phone ? 0 : 6,
                gap: props.phone ? 0 : 2,
                width: props.phone ? undefined : 158,
                flexShrink: 0,
                borderRightWidth: props.phone ? 0 : 1,
                borderBottomWidth: props.phone ? 1 : 0,
                borderColor: c().border,
              }}
            >
              <Each of={editorTabs}>
                {(entry) => (
                  <If
                    when={props.phone}
                    else={
                      <View
                        role="tab"
                        accessibilityLabel={tabLabel(entry())}
                        accessibilityState={{ selected: tab() === entry() }}
                        onPress={() => tab.set(entry())}
                        hoverStyle={{ backgroundColor: c().selected }}
                        style={{
                          ...row,
                          height: 30,
                          paddingHorizontal: 10,
                          backgroundColor:
                            tab() === entry() ? c().selected : c().canvas,
                          cursor: "pointer",
                        }}
                      >
                        <Label
                          line={20}
                          tone={tab() === entry() ? "ink" : "mutedInk"}
                        >
                          {tabLabel(entry())}
                        </Label>
                      </View>
                    }
                  >
                    <View
                      role="tab"
                      accessibilityLabel={tabLabel(entry())}
                      accessibilityState={{ selected: tab() === entry() }}
                      onPress={() => tab.set(entry())}
                      style={{
                        flex: 1,
                        height: 40,
                        alignItems: "center",
                        justifyContent: "center",
                        borderBottomWidth: tab() === entry() ? 2 : 0,
                        borderColor: c().ink,
                        cursor: "pointer",
                      }}
                    >
                      <Label
                        size={12}
                        line={16}
                        weight={tab() === entry() ? 600 : 400}
                        tone={tab() === entry() ? "ink" : "mutedInk"}
                      >
                        {tabLabel(entry())}
                      </Label>
                    </View>
                  </If>
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
                <If when={!pinned() && tab() !== "general"}>{deleteRow()}</If>
              </Scroll>
              <If when={pinned()}>{deleteRow()}</If>
            </View>
          </View>
        }
      >
        <View
          style={{
            ...row,
            height: 40,
            flexShrink: 0,
            gap: 12,
            paddingHorizontal: 14,
            borderBottomWidth: 1,
            borderColor: c().border,
          }}
        >
          <View style={{ ...row, gap: 8 }}>
            <Label
              size={10}
              line={12}
              tone="muted"
              style={{ letterSpacing: 0.8 }}
            >{`${step()}/2`}</Label>
            <Label size={12} line={16} weight={600}>
              {step() === 1
                ? localizedText("Name and model", "名称与模型")
                : uiText("instructions")}
            </Label>
          </View>
          <Label
            size={12}
            line={16}
            tone="muted"
            style={{ flex: 1, textAlign: "right" }}
          >
            {step() === 1
              ? localizedText("Next: Instructions", "下一步：指令")
              : uiText("lastStep")}
          </Label>
          <View style={{ ...row, gap: 4 }}>
            <View
              style={{
                width: 8,
                height: 8,
                backgroundColor: step() === 1 ? c().ink : c().faint,
              }}
            />
            <View
              style={{
                width: 8,
                height: 8,
                borderWidth: step() === 2 ? 0 : 1,
                borderColor: c().strong,
                backgroundColor: step() === 2 ? c().ink : undefined,
              }}
            />
          </View>
        </View>
        <Scroll
          style={props.phone ? grow : { flexShrink: 1 }}
          scrollbar={false}
        >
          <If when={step() === 1} else={<AgentInstructions form={form} />}>
            <AgentGeneral form={form} onModelServices={props.onModelServices} />
          </If>
        </Scroll>
      </If>
      <View
        style={{
          ...row,
          paddingHorizontal: phoneEditor() || !creating ? 16 : 14,
          paddingVertical: phoneEditor() ? 8 : creating ? undefined : 12,
          minHeight: creating && !phoneEditor() ? 52 : undefined,
          justifyContent: "flex-end",
          gap: creating && !phoneEditor() ? 16 : 8,
          borderTopWidth: 1,
          borderColor: c().border,
        }}
      >
        <Button
          label={uiText("cancel")}
          onPress={close}
          disabled={busy()}
          size={phoneEditor() ? 32 : undefined}
          style={
            phoneEditor()
              ? { paddingHorizontal: 14 }
              : creating
                ? undefined
                : { paddingHorizontal: 12 }
          }
          tone={creating ? "ghost" : undefined}
        />
        <If when={creating && step() === 2}>
          <View style={{ flex: 1 }} />
          <Button
            label={localizedText("Previous", "上一步")}
            onPress={() => step.set(1)}
            disabled={busy()}
            size={phoneEditor() ? 32 : undefined}
            style={phoneEditor() ? { paddingHorizontal: 14 } : undefined}
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
              size={phoneEditor() ? 32 : undefined}
              style={
                phoneEditor()
                  ? { paddingHorizontal: 14 }
                  : creating
                    ? undefined
                    : { paddingHorizontal: 12 }
              }
              onPress={() => void save()}
            />
          }
        >
          <Button
            label={uiText("next")}
            tone="primary"
            disabled={!name().trim()}
            size={phoneEditor() ? 32 : undefined}
            style={phoneEditor() ? { paddingHorizontal: 14 } : undefined}
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
                onPress={() => void remove()}
              />
            </View>
          </View>
        </Modal>
      </If>
    </Modal>
  );
}
