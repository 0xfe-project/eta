import type { AgentEditorProps } from "./form";
import { signal, View } from "nsh";
import {
  Button,
  colors,
  dialogWidth,
  grow,
  Label,
  Modal,
  row,
  SmoothScroll,
} from "../../../components";
import { AgentFace } from "../../../components/agent-face";
import {
  BackButton,
  CloseButton,
} from "../../../components/navigation-buttons";
import {
  avatar,
  border,
  control,
  icon,
  space,
  weight,
} from "../../../components/tokens";

import { localizedText, uiText } from "../../../i18n";
import { createAgentForm } from "./form";
import { AgentGeneral } from "./general";
import { AgentInstructions } from "./instructions";
import { AgentPlugins } from "./plugins";

/** The editor dialog's height off phones, its header (taller on phones and when creating), its
 * tab column and a tab, and the footer when creating. */
const editorHeight = 520;
const phoneSheetHeight = "90%";
const headerHeight = 40;
const headerTallHeight = 48;
const tabsWidth = 160;
const tabRow = 32;
const footerHeight = 52;

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
            minHeight: props.phone ? control.touch : space[40],
            gap: space[16],
            paddingHorizontal: space[16],
            paddingVertical: space[8],
            borderBottomWidth: pinned() ? 0 : 1,
            borderTopWidth: pinned() ? 1 : 0,
            borderColor: c().border,
          }}
        >
          <Label style={{ flex: 1 }}>
            {localizedText("Delete agent", "删除智能体")}
          </Label>
          <Button
            label={localizedText("Delete", "删除")}
            icon="trash"
            disabled={busy()}
            size={props.phone ? control.md : undefined}
            style={{ gap: space[4], paddingHorizontal: space[12] }}
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
      width={creating ? dialogWidth.md : dialogWidth.xl}
      height={
        props.phone
          ? phoneEditor()
            ? "100%"
            : phoneSheetHeight
          : creating
            ? undefined
            : editorHeight
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
          minHeight:
            phoneEditor() || creating ? headerTallHeight : headerHeight,
          gap: phoneEditor() ? space[4] : space[8],
          paddingLeft: phoneEditor() ? space[8] : space[12],
          paddingRight: phoneEditor()
            ? space[8]
            : creating
              ? space[8]
              : space[12],
          borderBottomWidth: 1,
          borderColor: c().border,
        }}
      >
        <If when={phoneEditor()}>
          <BackButton
            disabled={busy()}
            size={control.touch}
            iconSize={icon.md}
            onPress={close}
          />
        </If>
        <View style={{ ...row, flex: 1, minWidth: 0, gap: space[8] }}>
          <If when={!creating}>
            <AgentFace
              id={props.id}
              seed={form.avatar?.worn()}
              size={avatar.md}
            />
          </If>
          <If
            when={phoneEditor()}
            else={
              <Label
                variant={creating ? "body" : "subtitle"}
                style={{ flex: 1 }}
                weight={weight.regular}
              >
                {title()}
              </Label>
            }
          >
            <Label weight={weight.strong} lines={1} style={{ flex: 1 }}>
              {title()}
            </Label>
          </If>
        </View>
        <If when={creating && props.onTemplates}>
          <Button
            label={localizedText("From a template", "从模版创建")}
            icon="book"
            tone="ghost"
            size={control.sm}
            disabled={busy()}
            style={{ gap: space[4], paddingHorizontal: space[8] }}
            onPress={() => props.onTemplates?.()}
          />
        </If>
        <If
          when={!phoneEditor()}
          else={
            <View
              style={{ width: space[40], height: space[40], flexShrink: 0 }}
            />
          }
        >
          <CloseButton
            disabled={busy()}
            size={control.sm}
            iconSize={icon.md}
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
                padding: props.phone ? 0 : space[8],
                gap: props.phone ? 0 : space[2],
                width: props.phone ? undefined : tabsWidth,
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
                          height: tabRow,
                          paddingHorizontal: space[12],
                          backgroundColor:
                            tab() === entry() ? c().selected : c().canvas,
                          cursor: "pointer",
                        }}
                      >
                        <Label tone={tab() === entry() ? "ink" : "mutedInk"}>
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
                        height: space[40],
                        alignItems: "center",
                        justifyContent: "center",
                        borderBottomWidth: tab() === entry() ? border.thick : 0,
                        borderColor: c().ink,
                        cursor: "pointer",
                      }}
                    >
                      <Label
                        variant="small"
                        weight={
                          tab() === entry() ? weight.strong : weight.regular
                        }
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
              <SmoothScroll style={grow} scrollbar={false}>
                <If when={tab() === "general"}>
                  <AgentGeneral
                    form={form}
                    onModelServices={props.onModelServices}
                    onRuntimes={props.onRuntimes}
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
              </SmoothScroll>
              <If when={pinned()}>{deleteRow()}</If>
            </View>
          </View>
        }
      >
        <View
          style={{
            ...row,
            height: space[40],
            flexShrink: 0,
            gap: space[12],
            paddingHorizontal: space[16],
            borderBottomWidth: 1,
            borderColor: c().border,
          }}
        >
          <View style={{ ...row, gap: space[8] }}>
            <Label
              tracking="caps"
              variant="caption"
              tone="muted"
            >{`${step()}/2`}</Label>
            <Label variant="small" weight={weight.strong}>
              {step() === 1
                ? localizedText("Name and model", "名称与模型")
                : uiText("instructions")}
            </Label>
          </View>
          <Label
            variant="small"
            tone="muted"
            style={{ flex: 1, textAlign: "right" }}
          >
            {step() === 1
              ? localizedText("Next: Instructions", "下一步：指令")
              : uiText("lastStep")}
          </Label>
          <View style={{ ...row, gap: space[4] }}>
            <View
              style={{
                width: space[8],
                height: space[8],
                backgroundColor: step() === 1 ? c().ink : c().faint,
              }}
            />
            <View
              style={{
                width: space[8],
                height: space[8],
                borderWidth: step() === 2 ? 0 : 1,
                borderColor: c().strong,
                backgroundColor: step() === 2 ? c().ink : undefined,
              }}
            />
          </View>
        </View>
        <SmoothScroll
          style={props.phone ? grow : { flexShrink: 1 }}
          scrollbar={false}
        >
          <If when={step() === 1} else={<AgentInstructions form={form} />}>
            <AgentGeneral
              form={form}
              onModelServices={props.onModelServices}
              onRuntimes={props.onRuntimes}
            />
          </If>
        </SmoothScroll>
      </If>
      <View
        style={{
          ...row,
          paddingHorizontal: space[16],
          paddingVertical: phoneEditor()
            ? space[8]
            : creating
              ? undefined
              : space[12],
          minHeight: creating && !phoneEditor() ? footerHeight : undefined,
          justifyContent: "flex-end",
          gap: creating && !phoneEditor() ? space[16] : space[8],
          borderTopWidth: 1,
          borderColor: c().border,
        }}
      >
        <Button
          label={uiText("cancel")}
          onPress={close}
          disabled={busy()}
          size={phoneEditor() ? control.lg : undefined}
          style={
            phoneEditor()
              ? { paddingHorizontal: space[16] }
              : creating
                ? undefined
                : { paddingHorizontal: space[12] }
          }
          tone={creating ? "ghost" : undefined}
        />
        <If when={creating && step() === 2}>
          <View style={{ flex: 1 }} />
          <Button
            label={localizedText("Previous", "上一步")}
            onPress={() => step.set(1)}
            disabled={busy()}
            size={phoneEditor() ? control.lg : undefined}
            style={phoneEditor() ? { paddingHorizontal: space[16] } : undefined}
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
              disabled={!canSave() && !busy()}
              busy={busy()}
              size={phoneEditor() ? control.lg : undefined}
              style={
                phoneEditor()
                  ? { paddingHorizontal: space[16] }
                  : creating
                    ? undefined
                    : { paddingHorizontal: space[12] }
              }
              onPress={() => void save()}
            />
          }
        >
          <Button
            label={uiText("next")}
            tone="primary"
            disabled={!name().trim()}
            size={phoneEditor() ? control.lg : undefined}
            style={phoneEditor() ? { paddingHorizontal: space[16] } : undefined}
            onPress={() => step.set(2)}
          />
        </If>
      </View>
      <If when={deleting()}>
        <Modal
          title={localizedText("Delete agent?", "删除智能体？")}
          phone={props.phone}
          width={dialogWidth.md}
          modalFocus
          overPhoneNavigation
          onClose={() => {
            if (!busy()) deleting.set(false);
          }}
        >
          <View style={{ padding: space[16], gap: space[12] }}>
            <Label>
              {localizedText(
                `Delete ${title()}? Its direct chat will be archived. Its files stay on the host.`,
                `删除${title()}？其私聊将归档，文件会留在主机上。`,
              )}
            </Label>
            <View style={{ ...row, justifyContent: "flex-end", gap: space[8] }}>
              <Button
                label={uiText("cancel")}
                disabled={busy()}
                onPress={() => deleting.set(false)}
              />
              <Button
                label={localizedText("Delete", "删除")}
                tone="danger"
                busy={busy()}
                onPress={() => void remove()}
              />
            </View>
          </View>
        </Modal>
      </If>
    </Modal>
  );
}
