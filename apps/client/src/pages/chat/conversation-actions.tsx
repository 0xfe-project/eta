import type { ConversationInfo, MemberView } from "@eta/client-contracts";
import { Scroll, signal, View } from "nsh";
import { Button, Field, Label, Modal, row } from "../../components";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";

type Section =
  | "Conversation actions"
  | "Edit conversation"
  | "Members"
  | "Related tasks"
  | "Remove member"
  | "Change steward";

export function ConversationActions(props: {
  info: ConversationInfo;
  members: MemberView[];
  phone: boolean;
  captain?: boolean;
  onClose: () => void;
}) {
  const host = useHost();
  const section = signal<Section>("Conversation actions");
  const name = signal(props.info.name);
  const goal = signal(props.info.goal);
  const decisions = signal(props.info.decided);
  const removing = signal("");
  const busy = signal(false);
  const error = signal("");
  const group = () => props.info.kind === "group";
  const memberName = (id: string) => host.agent(id)?.name ?? id;

  function open(next: Section) {
    error.set("");
    section.set(next);
  }
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
      title={section()}
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
          <If when={section() === "Conversation actions"}>
            <Button
              label={uiText("editConversation")}
              onPress={() => open("Edit conversation")}
            />
            <Button
              label={uiText("relatedTasks")}
              onPress={() => open("Related tasks")}
            />
            <If when={group()}>
              <Button
                label={uiText("manageMembers")}
                onPress={() => open("Members")}
              />
              <Button
                label={uiText("changeSteward")}
                disabled={props.info.archived}
                onPress={() => open("Change steward")}
              />
            </If>
            <If when={!props.captain}>
              <Button
                label={
                  props.info.archived
                    ? uiText("restoreConversation")
                    : uiText("archiveConversation")
                }
                disabled={busy()}
                onPress={() =>
                  void save(
                    () => update({ archived: !props.info.archived }),
                    props.onClose,
                  )
                }
              />
            </If>
          </If>
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
          <If when={section() === "Members"}>
            <Each of={props.members} key={(member) => member.agentId}>
              {(member) => (
                <View style={{ ...row, gap: 8 }}>
                  <Label style={{ flex: 1 }}>
                    {memberName(member().agentId)}
                  </Label>
                  <Button
                    label={uiText("remove", {
                      memberName: memberName(member().agentId),
                    })}
                    disabled={
                      busy() || props.members.length <= 1 || props.info.archived
                    }
                    onPress={() => {
                      removing.set(member().agentId);
                      open("Remove member");
                    }}
                  />
                </View>
              )}
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
              tone="danger"
              disabled={busy() || props.members.length <= 1}
              onPress={() =>
                void save(
                  () =>
                    host.call("conversations", "remove", {
                      conversationId: props.info.id,
                      agentId: removing(),
                    }),
                  () => open("Members"),
                )
              }
            />
          </If>
          <If when={section() === "Change steward"}>
            <Each of={props.members} key={(member) => member.agentId}>
              {(member) => (
                <Button
                  label={memberName(member().agentId)}
                  selected={props.info.stewardId === member().agentId}
                  disabled={busy()}
                  onPress={() =>
                    void save(
                      () =>
                        host.call("conversations", "setSteward", {
                          conversationId: props.info.id,
                          agentId: member().agentId,
                        }),
                      props.onClose,
                    )
                  }
                />
              )}
            </Each>
            <Button
              label={uiText("noSteward")}
              selected={!props.info.stewardId}
              disabled={busy()}
              onPress={() =>
                void save(
                  () =>
                    host.call("conversations", "setSteward", {
                      conversationId: props.info.id,
                      agentId: null,
                    }),
                  props.onClose,
                )
              }
            />
          </If>
          <If when={error()}>
            <Label tone="red">{error()}</Label>
          </If>
          <If when={section() !== "Conversation actions"}>
            <Button
              label={uiText("back")}
              tone="ghost"
              disabled={busy()}
              onPress={() =>
                open(
                  section() === "Remove member"
                    ? "Members"
                    : "Conversation actions",
                )
              }
            />
          </If>
        </View>
      </Scroll>
    </Modal>
  );
}
