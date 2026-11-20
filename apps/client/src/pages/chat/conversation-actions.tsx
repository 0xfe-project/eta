import type { ConversationInfo, MemberView } from "@eta/client-contracts";
import type { ViewStyle } from "nsh";
import { Scroll, signal, View } from "nsh";
import {
  ActionItem,
  ActionMenu,
  Button,
  Field,
  Label,
  Modal,
  row,
} from "../../components";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";

/** What a conversation's actions open: a dialog for each that needs one. */
export interface ConversationAction {
  section: "Edit conversation" | "Related tasks" | "Remove member";
  /** The member to remove. */
  agentId?: string;
}

/**
 * The members header's "…": a menu (a sheet on touch screens) of the
 * conversation's own actions. The steward and the removal of a member are on
 * each member's row.
 */
export function ConversationActionsMenu(props: {
  info?: ConversationInfo;
  captain?: boolean;
  /** The tablet menu's 14px rows. */
  roomy?: boolean;
  triggerStyle?: ViewStyle;
  onOpen: (action: ConversationAction) => void;
}) {
  const host = useHost();
  const linked = () =>
    host
      .tasks()
      .filter((task) => props.info && task.conversationId === props.info.id)
      .length;
  return (
    <If
      when={props.info}
      else={
        <Button
          label={uiText("conversationActions")}
          icon="more"
          iconOnly
          tone="ghost"
          disabled
          onPress={() => {}}
          style={props.triggerStyle}
        />
      }
    >
      {(info) => (
        <ActionMenu
          label={uiText("conversationActions")}
          sheetTitle={info().name}
          popupWidth={props.roomy ? 160 : undefined}
          lifted={props.roomy}
          triggerStyle={props.triggerStyle}
        >
          <ActionItem
            label={uiText(
              info().kind === "group" || props.captain
                ? "editGroupInfo"
                : "editConversation",
            )}
            roomy={props.roomy}
            onSelect={() => props.onOpen({ section: "Edit conversation" })}
          />
          <ActionItem
            label={uiText("relatedTasks")}
            detail={linked() ? String(linked()) : undefined}
            roomy={props.roomy}
            onSelect={() => props.onOpen({ section: "Related tasks" })}
          />
          {/* Captain's conversation is the way to Captain: the host refuses
              to archive it. */}
          <If when={!props.captain || info().archived}>
            <ActionItem
              label={uiText(info().archived ? "unarchive" : "archive")}
              roomy={props.roomy}
              onSelect={() =>
                void host.action(() =>
                  host.call("conversations", "update", {
                    conversationId: info().id,
                    archived: !info().archived,
                  }),
                )
              }
            />
          </If>
        </ActionMenu>
      )}
    </If>
  );
}

export function ConversationActions(props: {
  info: ConversationInfo;
  members: MemberView[];
  phone: boolean;
  action: ConversationAction;
  onClose: () => void;
}) {
  const host = useHost();
  const section = () => props.action.section;
  const name = signal(props.info.name);
  const goal = signal(props.info.goal);
  const decisions = signal(props.info.decided);
  const removing = () => props.action.agentId ?? "";
  const busy = signal(false);
  const error = signal("");
  const group = () => props.info.kind === "group";
  const memberName = (id: string) => host.agent(id)?.name ?? id;
  const title = () =>
    section() === "Edit conversation"
      ? uiText(group() ? "editGroupInfo" : "editConversation")
      : section() === "Related tasks"
        ? uiText("relatedTasks")
        : uiText("removeMember");
  async function save(operation: () => Promise<unknown>, then?: () => void) {
    if (busy()) return;
    busy.set(true);
    error.set("");
    try {
      await operation();
      then?.();
    } catch (cause) {
      error.set(cause instanceof Error ? cause.message : String(cause));
    } finally {
      busy.set(false);
    }
  }
  const update = (
    changes: Partial<
      Pick<ConversationInfo, "name" | "goal" | "decided" | "archived">
    >,
  ) =>
    host.call("conversations", "update", {
      conversationId: props.info.id,
      ...changes,
    });
  return (
    <Modal
      title={title()}
      width={432}
      phone={props.phone}
      sheet={props.phone}
      overPhoneNavigation
      modalFocus
      dismissible={!busy()}
      onClose={props.onClose}
    >
      <Scroll style={{ maxHeight: 460 }}>
        <View style={{ padding: 16, gap: 10 }}>
          <If when={section() === "Edit conversation"}>
            <If when={group()}>
              <Label>{uiText("groupName")}</Label>
              <Field
                label={uiText("groupName")}
                value={name()}
                maxLength={100}
                onChange={name.set}
              />
            </If>
            <Label>{uiText("goal")}</Label>
            <Field
              label={uiText("goal")}
              multiline
              maxLength={10000}
              value={goal()}
              onChange={goal.set}
            />
            <Label>{uiText("decisions")}</Label>
            <Field
              label={uiText("decisions")}
              multiline
              maxLength={10000}
              value={decisions()}
              onChange={decisions.set}
            />
            <Button
              label={uiText("saveChanges")}
              tone="primary"
              disabled={busy() || (group() && !name().trim())}
              onPress={() =>
                void save(
                  () =>
                    update({
                      ...(group() ? { name: name().trim() } : {}),
                      goal: goal(),
                      decided: decisions(),
                    }),
                  props.onClose,
                )
              }
            />
          </If>
          <If when={section() === "Related tasks"}>
            <If when={!host.tasks().length}>
              <Label tone="muted">{uiText("noTasksYet")}</Label>
            </If>
            <Each of={host.tasks()} key={(task) => task.id}>
              {(task) => {
                const linked = () => task().conversationId === props.info.id;
                return (
                  <View style={{ ...row, gap: 8 }}>
                    <Label
                      style={{ flex: 1 }}
                    >{`#${task().number} ${task().title}`}</Label>
                    <Button
                      label={
                        linked()
                          ? uiText("unlinkTask", { number: task().number })
                          : uiText("linkTask", { number: task().number })
                      }
                      disabled={busy() || (!linked() && props.info.archived)}
                      onPress={() =>
                        void save(() =>
                          host.call("tasks", "link", {
                            taskId: task().id,
                            conversationId: linked() ? null : props.info.id,
                          }),
                        )
                      }
                    />
                  </View>
                );
              }}
            </Each>
          </If>
          <If when={section() === "Remove member"}>
            <Label>
              {uiText("removeFrom", {
                memberName: memberName(removing()),
                name: props.info.name,
              })}
            </Label>
            <Button
              label={uiText("removeMember")}
              disabled={busy() || props.members.length <= 1}
              onPress={() =>
                void save(
                  () =>
                    host.call("conversations", "remove", {
                      conversationId: props.info.id,
                      agentId: removing(),
                    }),
                  props.onClose,
                )
              }
            />
          </If>
          <If when={error()}>
            <Label tone="red">{error()}</Label>
          </If>
          <If when={section() === "Remove member"}>
            <Button
              label={uiText("cancel")}
              tone="ghost"
              disabled={busy()}
              onPress={props.onClose}
            />
          </If>
        </View>
      </Scroll>
    </Modal>
  );
}
