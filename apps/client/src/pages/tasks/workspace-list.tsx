import type { BoardTaskStatus, BoardTaskView } from "@eta/client-contracts";
import type { Signal } from "nsh";
import type { Layout } from "../../components";
import { computed, Scroll, View } from "nsh";
import { Button, colors, grow, Label, row } from "../../components";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";
import { TaskTableRow } from "./list";
import { TaskPlanBoard } from "./plan";
import { progressColor, statusName, TaskGlyph } from "./status";
import { visibleStatuses } from "./workspace-board";

export function TaskWorkspaceList(props: {
  layout: Layout;
  view: string;
  items: BoardTaskView[];
  groupByParent: boolean;
  foldedParents: Signal<string[]>;
  expanded: string[];
  onFoldStatus: (status: string) => void;
  onOpen: (id: string) => void;
}) {
  const host = useHost();
  const c = colors();
  const phone = () => props.layout === "phone";
  const column = (status: BoardTaskStatus) =>
    props.items.filter((task) => task.status === status);
  const byParent = computed(() => {
    const tasks = new Map(host.tasks().map((task) => [task.id, task]));
    const groups = new Map<string, BoardTaskView[]>();
    for (const task of props.items) {
      const key =
        task.parentId && tasks.has(task.parentId) ? task.parentId : "";
      const entries = groups.get(key) ?? [];
      entries.push(task);
      groups.set(key, entries);
      if (task.subtasks?.total && !groups.has(task.id)) groups.set(task.id, []);
    }
    return {
      groups: [...groups].flatMap(([id, children]) => {
        const parent = tasks.get(id);
        return parent
          ? [{ parent, children: children.sort((a, b) => a.number - b.number) }]
          : [];
      }),
      orphans: (groups.get("") ?? []).filter((task) => !groups.has(task.id)),
    };
  });
  return (
    <Scroll style={grow}>
      <View
        style={{
          padding: props.groupByParent || props.view === "Plan" ? 0 : 22,
          gap: props.groupByParent ? 0 : 12,
        }}
      >
        <If when={props.view === "Plan" && !phone()}>
          <TaskPlanBoard items={props.items} onOpen={props.onOpen} />
        </If>
        <If when={props.groupByParent}>
          <Each of={byParent().groups} key={(group) => group.parent.id}>
            {(group) => {
              const isFolded = () =>
                props.foldedParents().includes(group().parent.id);
              return (
                <View>
                  <View
                    style={{
                      ...row,
                      paddingLeft: 8,
                      borderBottomWidth: 1,
                      borderColor: c().border,
                      backgroundColor: c().surface,
                    }}
                  >
                    <Button
                      label={`${isFolded() ? "Expand" : "Collapse"} ${group().parent.title}`}
                      icon={isFolded() ? "right" : "down"}
                      iconOnly
                      tone="ghost"
                      onPress={() =>
                        props.foldedParents.update((ids) =>
                          isFolded()
                            ? ids.filter((id) => id !== group().parent.id)
                            : [...ids, group().parent.id],
                        )
                      }
                    />
                    <View
                      role="button"
                      accessibilityLabel={group().parent.title}
                      onPress={() => props.onOpen(group().parent.id)}
                      style={{
                        ...row,
                        flex: 1,
                        height: 29,
                        paddingRight: 14,
                        gap: 8,
                        cursor: "pointer",
                      }}
                    >
                      <TaskGlyph status={group().parent.status} size={12} />
                      <Label size={12} weight={600} lines={1}>
                        {group().parent.title}
                      </Label>
                      <Label
                        size={10}
                        tone="muted"
                        lines={1}
                        style={{ flex: 1 }}
                      >
                        {uiText("subtasksDone", {
                          number: group().parent.number,
                          value2: group().parent.subtasks?.total ?? 0,
                          value3: group().parent.subtasks?.done ?? 0,
                          value4: group().parent.subtasks?.total ?? 0,
                        })}
                      </Label>
                      <View
                        style={{
                          ...row,
                          gap: 2,
                          width: props.layout === "desktop" ? 80 : 90,
                        }}
                      >
                        <Each
                          of={host
                            .tasks()
                            .filter(
                              (child) => child.parentId === group().parent.id,
                            )
                            .sort((a, b) => a.number - b.number)}
                          key={(child) => child.id}
                        >
                          {(child) => (
                            <View
                              style={{
                                height: props.layout === "desktop" ? 4 : 3,
                                flex: 1,
                                backgroundColor: progressColor(
                                  child().status,
                                  c(),
                                ),
                              }}
                            />
                          )}
                        </Each>
                      </View>
                    </View>
                  </View>
                  <If when={!isFolded()}>
                    <View>
                      <Each of={group().children} key={(task) => task.id}>
                        {(task) => (
                          <TaskTableRow
                            layout={props.layout}
                            nested
                            item={task()}
                            onOpen={() => props.onOpen(task().id)}
                          />
                        )}
                      </Each>
                    </View>
                  </If>
                </View>
              );
            }}
          </Each>
          <If when={byParent().orphans.length}>
            <View>
              <View
                style={{
                  ...row,
                  height: 29,
                  paddingHorizontal: 14,
                  gap: 6,
                  backgroundColor: c().surface,
                  borderBottomWidth: 1,
                  borderColor: c().border,
                }}
              >
                <Label size={10} line={12} tone="mutedInk">
                  {uiText("notPartOfAnything")}
                </Label>
                <Label size={10} line={12} tone="muted">
                  {byParent().orphans.length}
                </Label>
              </View>
              <Each of={byParent().orphans} key={(task) => task.id}>
                {(task) => (
                  <TaskTableRow
                    layout={props.layout}
                    item={task()}
                    onOpen={() => props.onOpen(task().id)}
                  />
                )}
              </Each>
            </View>
          </If>
        </If>
        <If when={(props.view !== "Plan" || phone()) && !props.groupByParent}>
          <Each of={visibleStatuses}>
            {(status) => (
              <View style={{ gap: 5 }}>
                <Button
                  label={`${statusName(status())} ${column(status()).length}`}
                  tone="ghost"
                  end={props.expanded.includes(status()) ? "right" : "down"}
                  onPress={() => props.onFoldStatus(status())}
                />
                <If when={!props.expanded.includes(status())}>
                  <Each of={column(status())} key={(task) => task.id}>
                    {(task) => (
                      <TaskTableRow
                        layout={props.layout}
                        item={task()}
                        onOpen={() => props.onOpen(task().id)}
                      />
                    )}
                  </Each>
                </If>
              </View>
            )}
          </Each>
        </If>
      </View>
    </Scroll>
  );
}
