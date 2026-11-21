import type { TaskResults } from "@eta/client-contracts";
import type { JSX } from "nsh";
import { signal, View } from "nsh";
import {
  ActionItem,
  ActionMenu,
  Button,
  colors,
  Field,
  Label,
  Modal,
  row,
} from "../../components";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";
import { Segmented } from "./segmented";

export function NewTask(props: {
  phone: boolean;
  conversation?: string;
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  const host = useHost();
  const c = colors();
  const title = signal("");
  const description = signal("");
  const agent = signal("");
  const conversation = signal(props.conversation ?? "");
  const parent = signal("");
  const waitsFor = signal<string[]>([]);
  const start = signal<"ready" | "backlog">("ready");
  const busy = signal(false);
  const executor = () => agent() || host.people()[0]?.id || "";
  const groups = () =>
    host
      .conversations()
      .filter((item) => item.kind === "group" && !item.archived);
  const tasks = () =>
    host.tasks().filter((task) => task.status !== "cancelled");
  const titleOf = (id: string) =>
    host.tasks().find((task) => task.id === id)?.title ?? "";
  async function save() {
    if (busy() || !executor() || !title().trim()) return;
    busy.set(true);
    const result = await host.action(() =>
      host.call<TaskResults["create"]>("tasks", "create", {
        parent: parent() || undefined,
        tasks: [
          {
            title: title().trim(),
            description: description().trim(),
            assignee: executor(),
            dependsOn: waitsFor().map((task) => ({ task })),
          },
        ],
        status: start() === "backlog" ? "backlog" : "todo",
        conversationId: conversation() || undefined,
      }),
    );
    busy.set(false);
    if (result?.tasks[0]) {
      props.onClose();
      props.onOpen(result.tasks[0].id);
    }
  }
  const select = { width: 115, height: 24, paddingHorizontal: 9 };
  const link = { height: 24, paddingHorizontal: 0, borderWidth: 0 };
  return (
    <Modal
      title={uiText("newTask")}
      width={512}
      phone={props.phone}
      compact={!props.phone}
      onClose={props.onClose}
    >
      <View
        style={
          props.phone ? { padding: 14, gap: 14 } : { paddingTop: 14, gap: 14 }
        }
      >
        <View style={{ gap: 12 }}>
          <Field
            label={uiText("title")}
            placeholder={uiText("newTaskTitlePlaceholder")}
            value={title()}
            onChange={title.set}
            style={{
              height: 30,
              paddingHorizontal: 10,
              fontSize: 12,
              lineHeight: 16,
              borderColor: c().strong,
            }}
          />
          <Field
            label={uiText("description")}
            placeholder={uiText("newTaskDescriptionPlaceholder")}
            value={description()}
            multiline
            onChange={description.set}
            style={{
              height: 72,
              paddingHorizontal: 10,
              paddingVertical: 8,
              fontSize: 12,
              lineHeight: 16,
              borderColor: c().strong,
            }}
          />
        </View>
        <View style={{ gap: 10 }}>
          <NewTaskRow label={uiText("executor")}>
            <ActionMenu
              label={uiText("executor")}
              value={host.agent(executor())?.name ?? uiText("unassigned")}
              truncateValue
              triggerStyle={select}
            >
              <Each of={host.people()} key={(entry) => entry.id}>
                {(entry) => (
                  <ActionItem
                    label={entry().name}
                    checked={executor() === entry().id}
                    onSelect={() => agent.set(entry().id)}
                  />
                )}
              </Each>
            </ActionMenu>
          </NewTaskRow>
          <NewTaskRow label={uiText("taskBelongsTo")}>
            <ActionMenu
              label={uiText("taskBelongsTo")}
              value={
                parent() ? titleOf(parent()) : `+ ${uiText("pickAPieceOfWork")}`
              }
              truncateValue
              triggerStyle={link}
            >
              <ActionItem
                label={uiText("none")}
                checked={!parent()}
                onSelect={() => parent.set("")}
              />
              <Each of={tasks()} key={(task) => task.id}>
                {(task) => (
                  <ActionItem
                    label={`#${task().number} ${task().title}`}
                    checked={parent() === task().id}
                    onSelect={() => parent.set(task().id)}
                  />
                )}
              </Each>
            </ActionMenu>
          </NewTaskRow>
          <NewTaskRow label={uiText("newTaskIn")}>
            <ActionMenu
              label={uiText("newTaskIn")}
              value={
                groups().find((entry) => entry.id === conversation())?.name ??
                uiText("none")
              }
              truncateValue
              triggerStyle={select}
            >
              <ActionItem
                label={uiText("none")}
                checked={!conversation()}
                onSelect={() => conversation.set("")}
              />
              <Each of={groups()} key={(entry) => entry.id}>
                {(entry) => (
                  <ActionItem
                    label={entry().name}
                    checked={conversation() === entry().id}
                    onSelect={() => conversation.set(entry().id)}
                  />
                )}
              </Each>
            </ActionMenu>
          </NewTaskRow>
          <NewTaskRow label={uiText("taskWaitsForLabel")}>
            <ActionMenu
              label={uiText("taskWaitsForLabel")}
              value={
                waitsFor().length
                  ? waitsFor().map(titleOf).join(", ")
                  : `+ ${uiText("newTaskAdd")}`
              }
              truncateValue
              triggerStyle={{ ...link, maxWidth: 380 }}
            >
              <Each of={tasks()} key={(task) => task.id}>
                {(task) => (
                  <ActionItem
                    label={`#${task().number} ${task().title}`}
                    checked={waitsFor().includes(task().id)}
                    onSelect={() =>
                      waitsFor.update((ids) =>
                        ids.includes(task().id)
                          ? ids.filter((id) => id !== task().id)
                          : [...ids, task().id],
                      )
                    }
                  />
                )}
              </Each>
            </ActionMenu>
          </NewTaskRow>
          <NewTaskRow label={uiText("newTaskStart")}>
            <Segmented
              options={[
                { value: "ready", label: uiText("whenReady") },
                { value: "backlog", label: uiText("backlogFirst") },
              ]}
              value={start()}
              paddingHorizontal={8}
              bordered={false}
              onChange={start.set}
            />
          </NewTaskRow>
        </View>
        <View style={{ ...row, gap: 8, justifyContent: "flex-end" }}>
          <Button label={uiText("cancel")} onPress={props.onClose} />
          <Button
            label={uiText("newTaskCreate")}
            tone="primary"
            disabled={!title().trim() || !executor() || busy()}
            onPress={() => void save()}
          />
        </View>
      </View>
    </Modal>
  );
}

function NewTaskRow(props: { label: string; children: JSX.Element }) {
  return (
    <View style={{ ...row, gap: 14 }}>
      <Label size={12} line={16} tone="mutedInk" style={{ width: 62 }}>
        {props.label}
      </Label>
      {props.children}
    </View>
  );
}
