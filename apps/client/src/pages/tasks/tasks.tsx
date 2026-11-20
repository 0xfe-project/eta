import type { BoardTaskStatus, BoardTaskView } from "@eta/client-contracts";
import type { Layout } from "../../components";
import { signal, View } from "nsh";
import {
  ActionItem,
  ActionMenu,
  Button,
  colors,
  Empty,
  Field,
  grow,
  Header,
  row,
} from "../../components";
import { uiText } from "../../i18n";
import { follow, useHost } from "../../services/host";
import { taskDropZones } from "./drag";
import { PhoneTaskList } from "./list";
import { TaskWorkspaceBoard } from "./workspace-board";
import { TaskWorkspaceList } from "./workspace-list";

const taskViews = {
  Board: "boardView",
  List: "listView",
  Plan: "plan",
} as const;

export function Tasks(props: {
  layout: Layout;
  condensed?: boolean;
  onOpen: (id: string) => void;
  onCreate: () => void;
}) {
  const host = useHost();
  const c = colors();
  follow(() => "tasks");
  const boardDrag = taskDropZones<BoardTaskStatus>((id, status) => {
    const task = host.tasks().find((item) => item.id === id);
    if (task && !task.subtasks && task.status !== status) {
      void host.action(() =>
        host.call("tasks", "update", { taskId: id, status }),
      );
    }
  });
  const view = signal("Board");
  const listGrouping = signal<"Part of" | "Status">("Part of");
  const foldedParents = signal<string[]>([]);
  const query = signal("");
  const archive = signal(false);
  const executor = signal("");
  const filterOpen = signal(false);
  const expanded = signal<string[]>([]);
  const part = signal("");
  const partOpen = signal(false);
  const phone = () => props.layout === "phone";
  const shown = () =>
    archive() ? host.list<BoardTaskView>("tasks", "archived") : host.tasks();
  const parents = () => shown().filter((entry) => entry.subtasks?.total);
  const filtered = () =>
    shown().filter(
      (task) =>
        (!executor() ||
          (task.assigneeAgentId ?? task.createdBy.agentId) === executor()) &&
        (!part() || task.parentId === part() || task.id === part()) &&
        `${task.title} #${task.number}`
          .toLowerCase()
          .includes(query().trim().toLowerCase()),
    );
  const groupByParent = () =>
    view() === "List" &&
    !archive() &&
    (props.layout !== "desktop" || listGrouping() === "Part of");
  const collapse = (status: string) =>
    expanded.update((items) =>
      items.includes(status)
        ? items.filter((entry) => entry !== status)
        : [...items, status],
    );
  return (
    <View style={{ ...grow, backgroundColor: c().canvas }}>
      <Header
        title={uiText("tasks2")}
        count={shown().length}
        layout={props.layout}
      >
        <If when={!phone()}>
          <Field
            label={uiText("searchTasks")}
            placeholder={uiText("search")}
            value={query()}
            onChange={query.set}
            style={{
              width: 142,
              height: 26,
              borderWidth: 0,
              backgroundColor: c().surface,
              fontSize: 12,
            }}
          />
          <If when={!props.condensed}>
            <Button
              label={host.agent(executor())?.name ?? uiText("executor")}
              end="down"
              tone="ghost"
              onPress={() => filterOpen.set(!filterOpen())}
            />
            <Button
              label={uiText("partOf", {
                value1:
                  parents().find((entry) => entry.id === part())?.title ??
                  uiText("allItems"),
              })}
              end="down"
              tone="ghost"
              onPress={() => partOpen.set(!partOpen())}
            />
            <Button
              label={uiText("archived", {
                length: host.list<BoardTaskView>("tasks", "archived").length,
              })}
              icon="archive"
              tone="ghost"
              selected={archive()}
              onPress={() => archive.set(!archive())}
            />
            <If
              when={
                props.layout === "desktop" && view() === "List" && !archive()
              }
            >
              <ActionMenu
                label={uiText("groupTasksBy")}
                value={uiText("taskGrouping", {
                  name: uiText(
                    listGrouping() === "Part of" ? "groupByPartOf" : "status",
                  ),
                })}
              >
                <Each of={["Part of", "Status"] as const}>
                  {(mode) => (
                    <ActionItem
                      label={uiText(
                        mode() === "Part of" ? "groupByPartOf" : "status",
                      )}
                      checked={listGrouping() === mode()}
                      onSelect={() => listGrouping.set(mode())}
                    />
                  )}
                </Each>
              </ActionMenu>
            </If>
            <View style={row}>
              <Each of={["Board", "List", "Plan"] as const}>
                {(mode) => (
                  <Button
                    label={uiText(taskViews[mode()])}
                    tone={view() === mode() ? "primary" : "plain"}
                    onPress={() => view.set(mode())}
                  />
                )}
              </Each>
            </View>
          </If>
        </If>
        <If when={!phone() && !props.condensed}>
          <Button
            label={uiText("new")}
            tone="primary"
            icon="plus"
            onPress={props.onCreate}
          />
        </If>
      </Header>
      <If when={partOpen()}>
        <View style={{ ...row, padding: 8, gap: 6 }}>
          <Button
            label={uiText("allTasks")}
            selected={!part()}
            onPress={() => {
              part.set("");
              partOpen.set(false);
            }}
          />
          <Each of={parents()} key={(task) => task.id}>
            {(entry) => (
              <Button
                label={entry().title}
                selected={part() === entry().id}
                onPress={() => {
                  part.set(entry().id);
                  partOpen.set(false);
                }}
              />
            )}
          </Each>
        </View>
      </If>
      <If when={filterOpen()}>
        <View style={{ ...row, padding: 8, gap: 6 }}>
          <Button
            label={uiText("allExecutors")}
            selected={!executor()}
            onPress={() => {
              executor.set("");
              filterOpen.set(false);
            }}
          />
          <Each of={host.people()} key={(agent) => agent.id}>
            {(agent) => (
              <Button
                label={agent().name}
                selected={executor() === agent().id}
                onPress={() => {
                  executor.set(agent().id);
                  filterOpen.set(false);
                }}
              />
            )}
          </Each>
        </View>
      </If>
      <If
        when={filtered().length}
        else={
          <Empty
            title={
              host.state().missing.tasks
                ? uiText("unableToLoadTasks")
                : !host.state().targets.tasks
                  ? uiText("loadingTasks")
                  : shown().length
                    ? uiText("noMatchingTasks")
                    : uiText("noTasksYet")
            }
            icon={host.state().missing.tasks ? "info" : "tasks"}
            description={
              host.state().missing.tasks
                ? uiText("theHostDidNotRespondIn")
                : undefined
            }
          >
            <If when={host.state().missing.tasks}>
              <Button
                label={uiText("retry")}
                icon="refresh"
                onPress={host.retry}
              />
            </If>
          </Empty>
        }
      >
        <If
          when={!phone() && !props.condensed}
          else={<PhoneTaskList tasks={filtered()} onOpen={props.onOpen} />}
        >
          <If
            when={view() === "Board" && !archive()}
            else={
              <TaskWorkspaceList
                layout={props.layout}
                view={view()}
                items={filtered()}
                groupByParent={groupByParent()}
                foldedParents={foldedParents}
                expanded={expanded()}
                onFoldStatus={collapse}
                onOpen={props.onOpen}
              />
            }
          >
            <TaskWorkspaceBoard
              items={filtered()}
              expanded={expanded()}
              drag={boardDrag}
              layout={props.layout}
              onFoldStatus={collapse}
              onOpen={props.onOpen}
            />
          </If>
        </If>
      </If>
    </View>
  );
}
