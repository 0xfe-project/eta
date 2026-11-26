import type { TaskResults } from "@eta/client-contracts";
import type { JSX } from "nsh";
import { signal, View } from "nsh";
import {
  ActionItem,
  ActionMenu,
  Button,
  colors,
  dialogWidth,
  Field,
  Label,
  Modal,
  row,
  textFaces,
  textStyle,
} from "../../components";
import { sendShortcut } from "../../components/eta-editor";
import { control, space } from "../../components/tokens";
import { uiText } from "../../i18n";
import { agentAllowedOnMachine } from "../../services/agent-machine";
import { useHost } from "../../services/host";
import { createDescription, DescriptionBox } from "./description-box";
import { Segmented } from "./segmented";

/** The executor and workspace selects, and how far the "waits for" list runs. */
const selectWidth = 116;
const waitsForWidth = 380;

export function NewTask(props: {
  phone: boolean;
  conversation?: string;
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  const host = useHost();
  const c = colors();
  const type = textFaces();
  const title = signal("");
  const agent = signal("");
  const conversation = signal(props.conversation ?? "");
  const parent = signal("");
  const waitsFor = signal<string[]>([]);
  const start = signal<"ready" | "backlog">("ready");
  const busy = signal(false);
  const groups = () =>
    host
      .conversations()
      .filter((item) => item.kind === "group" && !item.archived);
  const selectedParent = () =>
    parent() ? host.tasks().find((task) => task.id === parent()) : undefined;
  const effectiveGroup = () => {
    const chosenId = conversation() || selectedParent()?.conversationId;
    return chosenId
      ? groups().find((entry) => entry.id === chosenId)
      : undefined;
  };
  const projectMachineId = () => {
    const projectId = effectiveGroup()?.projectId;
    if (!projectId) return undefined;
    const project = host.projects().find((entry) => entry.id === projectId);
    return project && project.kind !== "agent_home"
      ? project.machineId
      : undefined;
  };
  const eligiblePeople = () => {
    const group = effectiveGroup();
    const machineId = projectMachineId();
    const allowed = host
      .people()
      .filter((entry) => agentAllowedOnMachine(entry, machineId));
    if (group === undefined) return allowed;
    const members = new Set(group.participants.map((member) => member.agentId));
    return allowed.filter((entry) => members.has(entry.id));
  };
  const executor = () => {
    const candidates = eligiblePeople();
    const picked = agent();
    if (picked && candidates.some((entry) => entry.id === picked))
      return picked;
    return candidates[0]?.id || "";
  };
  const tasks = () =>
    host.tasks().filter((task) => task.status !== "cancelled");
  const titleOf = (id: string) =>
    host.tasks().find((task) => task.id === id)?.title ?? "";
  const description = createDescription({
    text: "",
    onSubmit: () => void save(),
  });
  const ready = () =>
    !!title().trim() && !!executor() && !busy() && !description.tooLong();
  async function save() {
    if (!ready()) return;
    busy.set(true);
    const result = await host.action(() =>
      host.call<TaskResults["create"]>("tasks", "create", {
        parent: parent() || undefined,
        tasks: [
          {
            title: title().trim(),
            description: description.read(),
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
  const select = {
    width: selectWidth,
    height: control.sm,
    paddingHorizontal: space[8],
  };
  const link = { height: control.sm, paddingHorizontal: 0, borderWidth: 0 };
  return (
    <Modal
      title={uiText("newTask")}
      width={dialogWidth.lg}
      phone={props.phone}
      compact={!props.phone}
      onClose={props.onClose}
    >
      <View
        style={
          props.phone
            ? { padding: space[16], gap: space[12] }
            : { paddingTop: space[16], gap: space[12] }
        }
      >
        <View style={{ gap: space[12] }}>
          <View style={{ gap: space[4] }}>
            <Label variant="caption">{uiText("title")}</Label>
            <Field
              label={uiText("title")}
              placeholder={uiText("newTaskTitlePlaceholder")}
              value={title()}
              onChange={title.set}
              style={{
                height: control.lg,
                paddingHorizontal: space[12],
                ...textStyle(type("small")),
                borderColor: c().strong,
              }}
            />
          </View>
          <View style={{ gap: space[4] }}>
            <Label variant="caption">{uiText("description")}</Label>
            <DescriptionBox
              description={description}
              label={uiText("description")}
              placeholder={uiText("newTaskDescriptionPlaceholder")}
              phone={props.phone}
            />
          </View>
        </View>
        <View style={{ gap: space[8] }}>
          <NewTaskRow label={uiText("executor")}>
            <ActionMenu
              label={uiText("executor")}
              value={host.agent(executor())?.name ?? uiText("unassigned")}
              truncateValue
              triggerStyle={select}
              empty={
                eligiblePeople().length ? undefined : uiText("noAgentsToPick")
              }
            >
              <Each of={eligiblePeople()} key={(entry) => entry.id}>
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
              triggerStyle={{ ...link, maxWidth: waitsForWidth }}
              empty={tasks().length ? undefined : uiText("noTasksToWaitFor")}
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
        <View style={{ ...row, gap: space[8], justifyContent: "flex-end" }}>
          <Button label={uiText("cancel")} onPress={props.onClose} />
          <Button
            label={uiText("newTaskCreate")}
            tone="primary"
            shortcut={props.phone ? undefined : sendShortcut}
            disabled={!ready() && !busy()}
            busy={busy()}
            onPress={() => void save()}
          />
        </View>
      </View>
    </Modal>
  );
}

/** A row's label column. */
const rowLabelWidth = 64;

function NewTaskRow(props: { label: string; children: JSX.Element }) {
  return (
    <View style={{ ...row, gap: space[12] }}>
      <Label variant="small" tone="mutedInk" style={{ width: rowLabelWidth }}>
        {props.label}
      </Label>
      {props.children}
    </View>
  );
}
