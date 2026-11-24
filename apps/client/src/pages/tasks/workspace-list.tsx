import type { BoardTaskStatus, BoardTaskView } from "@eta/client-contracts";
import type { Signal } from "nsh";
import type { Layout } from "../../components";
import { computed, View } from "nsh";
import {
  Button,
  colors,
  grow,
  Icon,
  Label,
  row,
  SmoothScroll,
} from "../../components";
import { foldNext } from "../../components/motion";
import { icon, space, weight } from "../../components/tokens";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";
import { TaskTableRow } from "./list";
import { TaskPlanBoard } from "./plan";
import { progressColor, statusName, TaskGlyph } from "./status";
import { UsageLine } from "./usage";
import { visibleStatuses } from "./workspace-board";

/** A parent's heading row over its subtasks (and the orphans'); its progress bar. */
const groupHeight = { tablet: 32, desktop: 28 } as const;
const progressWidth = { desktop: 80, tablet: 92 } as const;

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
  const tablet = () => props.layout === "tablet";
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
    <SmoothScroll style={grow}>
      <View
        style={{
          padding: props.groupByParent || props.view === "Plan" ? 0 : space[24],
          gap: props.groupByParent ? 0 : space[12],
        }}
      >
        <If when={props.view === "Plan" && !phone()}>
          <TaskPlanBoard
            items={props.items}
            tablet={tablet()}
            onOpen={props.onOpen}
          />
        </If>
        <If when={props.groupByParent}>
          <Each of={byParent().groups} key={(group) => group.parent.id}>
            {(group) => {
              const isFolded = () =>
                props.foldedParents().includes(group().parent.id);
              const fold = () => {
                foldNext();
                props.foldedParents.update((ids) =>
                  isFolded()
                    ? ids.filter((id) => id !== group().parent.id)
                    : [...ids, group().parent.id],
                );
              };
              const foldLabel = () =>
                `${isFolded() ? "Expand" : "Collapse"} ${group().parent.title}`;
              return (
                <View>
                  <View
                    style={{
                      ...row,
                      paddingLeft: tablet() ? space[16] : space[8],
                      gap: tablet() ? space[8] : 0,
                      borderBottomWidth: 1,
                      borderColor: c().border,
                      backgroundColor: tablet() ? c().selected : c().surface,
                    }}
                  >
                    <If
                      when={!tablet()}
                      else={
                        <View
                          role="button"
                          accessibilityLabel={foldLabel()}
                          onPress={fold}
                          style={{ cursor: "pointer" }}
                        >
                          <Icon
                            name={isFolded() ? "right" : "down"}
                            size={icon.sm}
                          />
                        </View>
                      }
                    >
                      <Button
                        label={foldLabel()}
                        icon={isFolded() ? "right" : "down"}
                        iconOnly
                        tone="ghost"
                        onPress={fold}
                      />
                    </If>
                    <View
                      role="button"
                      accessibilityLabel={group().parent.title}
                      onPress={() => props.onOpen(group().parent.id)}
                      style={{
                        ...row,
                        flex: 1,
                        height: tablet()
                          ? groupHeight.tablet
                          : groupHeight.desktop,
                        paddingRight: space[16],
                        gap: space[8],
                        cursor: "pointer",
                      }}
                    >
                      <TaskGlyph
                        status={group().parent.status}
                        size={icon.sm}
                      />
                      <Label variant="small" weight={weight.strong} lines={1}>
                        {group().parent.title}
                      </Label>
                      <Label
                        variant="caption"
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
                      <UsageLine
                        task={group().parent}
                        variant="caption"
                        style={{ flexShrink: 0, marginRight: space[8] }}
                      />
                      <View
                        style={{
                          ...row,
                          gap: space[2],
                          width:
                            props.layout === "desktop"
                              ? progressWidth.desktop
                              : progressWidth.tablet,
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
                                height: space[4],
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
                  height: tablet() ? groupHeight.tablet : groupHeight.desktop,
                  paddingHorizontal: space[16],
                  gap: tablet() ? space[8] : space[4],
                  backgroundColor: tablet() ? c().selected : c().surface,
                  borderBottomWidth: 1,
                  borderColor: c().border,
                }}
              >
                <Label variant="caption" tone="mutedInk">
                  {uiText("notPartOfAnything")}
                </Label>
                <Label variant="caption" tone="muted">
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
              <View style={{ gap: space[4] }}>
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
    </SmoothScroll>
  );
}
