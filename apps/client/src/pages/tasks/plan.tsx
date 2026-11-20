import type { BoardTaskDetail, TaskResults } from "@eta/client-contracts";
import { Scroll, signal, View } from "nsh";
import {
  ActionItem,
  ActionMenu,
  Button,
  colors,
  Field,
  grow,
  Label,
  Modal,
  row,
} from "../../components";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";
import { taskDropZones } from "./drag";
import { statusName, TaskGlyph } from "./status";

export function TaskPlan(props: {
  task: () => BoardTaskDetail;
  onOpen: (id: string) => void;
  desktop: boolean;
}) {
  const c = colors();
  const host = useHost();
  const adding = signal(false);
  const prerequisite = signal("");
  const dependent = signal("");
  const addingStep = signal(false);
  const stepTitle = signal("");
  const owner = () =>
    props.task().assigneeAgentId ??
    props.task().createdBy.agentId ??
    host.people()[0]?.id;
  const columnWidth = 164;
  const columnGap = 36;
  const cardHeight = 64;
  const cardGap = 10;
  const saving = signal(false);
  const children = () => {
    const parent = props.task();
    const visible = host.tasks().filter((task) => task.parentId === parent.id);
    const current = new Map(
      (parent.children ?? []).map((task) => [task.taskId, task]),
    );
    for (const { id, number, status, title } of visible)
      current.set(id, { taskId: id, number, status, title });
    return [...current.values()];
  };
  const planDrag = taskDropZones<string>((from, to) => {
    if (
      from === to ||
      saving() ||
      !children().some((child) => child.taskId === to)
    )
      return;
    prerequisite.set(from);
    dependent.set(to);
    void add();
  });
  const graph = () => {
    const references = children();
    const known = new Map(host.tasks().map((task) => [task.id, task]));
    const ids = new Set(references.map((task) => task.taskId));
    const levels = new Map<string, number>();
    const inStack = new Set<string>();
    const parents = new Map<string, string>();
    function level(id: string): number {
      const existing = levels.get(id);
      if (existing !== undefined) return existing;
      if (inStack.has(id)) return 0;
      inStack.add(id);
      const dependencies = (known.get(id)?.dependsOn ?? []).filter((edge) =>
        ids.has(edge.taskId),
      );
      let next = 0;
      for (const edge of dependencies) {
        const depth = level(edge.taskId) + 1;
        if (depth > next) {
          next = depth;
          parents.set(id, edge.taskId);
        }
      }
      inStack.delete(id);
      levels.set(id, next);
      return next;
    }
    const columns: (typeof references)[] = [];
    for (const task of references)
      (columns[level(task.taskId)] ??= []).push(task);
    const points = new Map(
      columns.flatMap((tasks, col) =>
        tasks.map(
          (task, row) =>
            [
              task.taskId,
              {
                x: col * (columnWidth + columnGap),
                y: 18 + cardHeight / 2 + row * (cardHeight + cardGap),
              },
            ] as const,
        ),
      ),
    );
    const critical = new Set<string>();
    let last = columns.at(-1)?.[0]?.taskId;
    while (last && !critical.has(last)) {
      critical.add(last);
      last = parents.get(last);
    }
    const edges = references.flatMap((task) =>
      (known.get(task.taskId)?.dependsOn ?? []).flatMap((edge) => {
        const start = points.get(edge.taskId);
        const end = points.get(task.taskId);
        if (!start || !end || end.x <= start.x) return [];
        return [
          {
            from: start,
            to: end,
            id: `${edge.taskId}/${task.taskId}`,
            primary:
              critical.has(task.taskId) &&
              parents.get(task.taskId) === edge.taskId,
          },
        ];
      }),
    );
    return { columns, edges, critical };
  };
  const steps = () => graph().columns;
  async function appendStep() {
    const assignee = owner();
    if (!assignee || !stepTitle().trim() || saving()) return;
    saving.set(true);
    const result = await host.action(() =>
      host.call<TaskResults["create"]>("tasks", "create", {
        parent: props.task().id,
        tasks: [
          {
            title: stepTitle().trim(),
            assignee,
            dependsOn: (steps().at(-1) ?? [])
              .filter((item) => item.status !== "cancelled")
              .map((item) => ({ task: item.taskId })),
          },
        ],
      }),
    );
    saving.set(false);
    if (result) addingStep.set(false);
  }
  async function add() {
    if (
      saving() ||
      !prerequisite() ||
      !dependent() ||
      prerequisite() === dependent()
    )
      return;
    saving.set(true);
    const result = await host.action(() =>
      host.call("tasks", "addDependency", {
        taskId: dependent(),
        dependsOn: prerequisite(),
      }),
    );
    saving.set(false);
    if (result) adding.set(false);
  }
  return (
    <View style={grow}>
      <View style={{ ...row, gap: 8, padding: 14 }}>
        <Label size={12} tone="muted" style={{ flex: 1 }}>
          {uiText("steps", {
            number: props.task().number,
            length: steps().length,
          })}
        </Label>
        <Button
          label={uiText("addDependency")}
          icon="plus"
          onPress={() => {
            prerequisite.set("");
            dependent.set("");
            adding.set(true);
          }}
        />
      </View>
      <Scroll style={grow} horizontal>
        <View style={{ padding: 16, gap: 10 }}>
          <View
            style={{
              position: "relative",
              flexDirection: "row",
              alignItems: "flex-start",
              gap: columnGap,
            }}
          >
            <Each of={graph().edges} key={(edge) => edge.id}>
              {(edge) => {
                const left = () => edge().from.x + columnWidth;
                const width = () => edge().to.x - left();
                const bend = () => left() + width() / 2;
                const tone = () => (edge().primary ? c().ink : c().strong);
                return (
                  <>
                    <View
                      style={{
                        position: "absolute",
                        left: left(),
                        top: edge().from.y,
                        width: width() / 2,
                        height: 1,
                        backgroundColor: tone(),
                      }}
                    />
                    <View
                      style={{
                        position: "absolute",
                        left: bend(),
                        top: Math.min(edge().from.y, edge().to.y),
                        width: 1,
                        height: Math.abs(edge().from.y - edge().to.y) + 1,
                        backgroundColor: tone(),
                      }}
                    />
                    <View
                      style={{
                        position: "absolute",
                        left: bend(),
                        top: edge().to.y,
                        width: width() / 2,
                        height: 1,
                        backgroundColor: tone(),
                      }}
                    />
                  </>
                );
              }}
            </Each>
            <Each of={steps()} key="index">
              {(items, index) => (
                <View style={{ width: columnWidth, gap: cardGap }}>
                  <View
                    style={{
                      ...row,
                      height: 8,
                      justifyContent: "space-between",
                    }}
                  >
                    <Label size={12} weight={600}>
                      {uiText("step", { value1: index() + 1 })}
                    </Label>
                    <Label size={11} tone="muted">
                      {uiText("doneWithCount", {
                        length: items().filter((task) => task.status === "done")
                          .length,
                        value2: items().length,
                      })}
                    </Label>
                  </View>
                  <Each of={items()} key={(task) => task.taskId}>
                    {(task) => {
                      const gesture = planDrag.gesture(task().taskId);
                      return (
                        <View
                          role="button"
                          ref={(view) => planDrag.register(task().taskId, view)}
                          onPress={() => props.onOpen(task().taskId)}
                          style={{
                            ...row,
                            height: cardHeight,
                            padding: 7,
                            gap: 6,
                            borderWidth: 1,
                            borderColor: graph().critical.has(task().taskId)
                              ? c().ink
                              : c().border,
                            backgroundColor: c().canvas,
                            cursor: "pointer",
                          }}
                        >
                          <TaskGlyph status={task().status} />
                          <View style={{ flex: 1, gap: 2 }}>
                            <Label size={12} lines={2}>
                              {task().title}
                            </Label>
                            <Label
                              size={11}
                              tone="muted"
                            >{`#${task().number} · ${statusName(task().status)}`}</Label>
                          </View>
                          <If when={props.desktop}>
                            <View
                              role="button"
                              accessibilityLabel={uiText("taskConnectFrom", {
                                number: task().number,
                              })}
                              onPressDown={gesture.onPressDown}
                              onPanStart={gesture.onPanStart}
                              onPanEnd={gesture.onPanEnd}
                              onPress={() => {
                                prerequisite.set(task().taskId);
                                dependent.set("");
                                adding.set(true);
                              }}
                              style={{
                                width: 14,
                                height: 20,
                                alignItems: "center",
                                justifyContent: "center",
                                cursor: "crosshair",
                              }}
                            >
                              <View
                                style={{
                                  width: 8,
                                  height: 8,
                                  borderWidth: 1,
                                  borderRadius: 4,
                                  borderColor: c().muted,
                                  backgroundColor: c().canvas,
                                }}
                              />
                            </View>
                          </If>
                        </View>
                      );
                    }}
                  </Each>
                  <If when={index() === steps().length - 1 && owner()}>
                    <Button
                      label={uiText("addAStepAtTheEnd")}
                      icon="plus"
                      size={32}
                      onPress={() => {
                        stepTitle.set("");
                        addingStep.set(true);
                      }}
                    />
                  </If>
                </View>
              )}
            </Each>
          </View>
          <View style={{ ...row, flexWrap: "wrap", gap: 10, paddingTop: 8 }}>
            <Each of={["done", "in_review", "in_progress", "todo"] as const}>
              {(status) => (
                <View style={{ ...row, gap: 4 }}>
                  <TaskGlyph status={status()} size={11} />
                  <Label size={11} tone="muted">
                    {statusName(status())}
                  </Label>
                </View>
              )}
            </Each>
            <View style={{ ...row, gap: 5 }}>
              <View
                style={{ width: 14, height: 1, backgroundColor: c().ink }}
              />
              <Label size={11} tone="muted">
                {uiText("criticalPath")}
              </Label>
            </View>
          </View>
        </View>
      </Scroll>
      <If when={addingStep()}>
        <Modal
          title={uiText("addAStepAtTheEnd")}
          width={440}
          overPhoneNavigation
          onClose={() => addingStep.set(false)}
        >
          <View style={{ padding: 16, gap: 8 }}>
            <Label size={12} tone="muted">
              {uiText("thisTaskWaitsForTheTasks")}
            </Label>
            <Field
              label={uiText("taskTitle")}
              value={stepTitle()}
              onChange={stepTitle.set}
              onSubmit={() => void appendStep()}
            />
            <Button
              label={uiText("addTask")}
              tone="primary"
              disabled={!stepTitle().trim() || saving()}
              onPress={() => void appendStep()}
            />
          </View>
        </Modal>
      </If>
      <If when={adding()}>
        <Modal
          title={uiText("addDependency")}
          width={440}
          onClose={() => adding.set(false)}
        >
          <View style={{ padding: 16, gap: 8 }}>
            <Label>{uiText("chooseTheTaskThatWaitsAnd")}</Label>
            <ActionMenu
              label={uiText("taskThatWaits")}
              value={
                children().find((task) => task.taskId === dependent())?.title ??
                "Select task"
              }
            >
              <Each of={children()} key={(task) => task.taskId}>
                {(task) => (
                  <ActionItem
                    label={task().title}
                    checked={dependent() === task().taskId}
                    onSelect={() => {
                      if (prerequisite() === task().taskId)
                        prerequisite.set("");
                      dependent.set(task().taskId);
                    }}
                  />
                )}
              </Each>
            </ActionMenu>
            <ActionMenu
              label={uiText("prerequisite")}
              value={
                children().find((task) => task.taskId === prerequisite())
                  ?.title ?? "Select prerequisite"
              }
            >
              <Each
                of={children().filter(
                  (task) =>
                    task.taskId !== dependent() && task.status !== "cancelled",
                )}
                key={(task) => task.taskId}
              >
                {(task) => (
                  <ActionItem
                    label={task().title}
                    checked={prerequisite() === task().taskId}
                    onSelect={() => prerequisite.set(task().taskId)}
                  />
                )}
              </Each>
            </ActionMenu>
            <Button
              label={uiText("addDependency")}
              tone="primary"
              disabled={saving() || !prerequisite() || !dependent()}
              onPress={() => void add()}
            />
          </View>
        </Modal>
      </If>
    </View>
  );
}
