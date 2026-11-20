import type { BoardTaskDetail, BoardTaskStatus } from "@eta/client-contracts";
import { View } from "nsh";
import { Button, Caption, colors, Icon, Label, row } from "../../components";
import { uiText } from "../../i18n";
import { statusName, TaskGlyph, tones } from "./status";

export function TaskLink(link: {
  item: {
    taskId: string;
    number: number;
    title: string;
    status: BoardTaskStatus;
  };
  suffix?: string;
  onTask: (id: string) => void;
}) {
  const c = colors();
  return (
    <View
      role="button"
      onPress={() => link.onTask(link.item.taskId)}
      hoverStyle={{ backgroundColor: c().selected }}
      style={{
        ...row,
        minHeight: 43,
        paddingVertical: 5,
        gap: 8,
        borderBottomWidth: 1,
        borderColor: c().border,
        cursor: "pointer",
      }}
    >
      <TaskGlyph status={link.item.status} size={12} />
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <Label size={13}>{`#${link.item.number} ${link.item.title}`}</Label>
        <If when={link.suffix}>
          <Label size={11} tone="muted">
            {link.suffix}
          </Label>
        </If>
      </View>
      <Icon name="right" size={10} tone="muted" />
    </View>
  );
}
export function Prerequisites(props: {
  item: BoardTaskDetail;
  submitting: boolean;
  onResolve: () => void;
  onReplace: () => void;
  onCancel: () => void;
  onTask: (id: string) => void;
}) {
  const c = colors();
  const waiting = () => props.item.waitingOn ?? [];
  const cancelled = () => waiting().some((edge) => edge.state === "cancelled");
  return (
    <If
      when={
        waiting().length &&
        (props.item.status === "todo" || props.item.status === "blocked")
      }
    >
      <View
        style={{
          padding: cancelled() ? 16 : 12,
          gap: 7,
          borderWidth: 1,
          borderColor: c().border,
          borderLeftWidth: cancelled() ? 2 : 1,
          borderLeftColor: cancelled() ? c().red : c().strong,
        }}
      >
        <View style={{ ...row, gap: 7 }}>
          <If when={!cancelled()}>
            <Icon name="lock" size={15} tone="muted" />
          </If>
          <Label size={13} weight={600}>
            {cancelled()
              ? uiText("thisTaskIsStuckAndNeeds")
              : uiText("waitingForPrerequisites")}
          </Label>
        </View>
        <Label size={12} line={18}>
          {cancelled()
            ? uiText("wasCancelledThisTaskStaysBlocked", {
                join: waiting()
                  .filter((edge) => edge.state === "cancelled")
                  .map((edge) => `“${edge.title}” (#${edge.number})`)
                  .join(", "),
              })
            : uiText("waitingForThisTaskStartsWhen", {
                join: waiting()
                  .map((edge) => `“${edge.title}”`)
                  .join(", "),
              })}
        </Label>
        <If
          when={
            waiting().some(
              (edge) => edge.state === "cancelled" && edge.via === null,
            ) && !props.item.archivedAt
          }
        >
          <View style={{ gap: 6, paddingVertical: 3 }}>
            <Button
              label={uiText("dontWaitStartNow")}
              size={40}
              tone="primary"
              disabled={props.submitting}
              onPress={props.onResolve}
            />
            <Button
              label={uiText("waitForAnotherTask")}
              size={40}
              disabled={props.submitting}
              onPress={props.onReplace}
            />
            <Button
              label={uiText("cancelThisTask")}
              size={40}
              disabled={props.submitting}
              onPress={props.onCancel}
            />
          </View>
        </If>
        <Each
          of={waiting().filter(
            (edge) => edge.state === "cancelled" || edge.via !== null,
          )}
          key={(edge) => edge.taskId}
        >
          {(edge) => {
            const ancestor = () =>
              props.item.ancestors?.find((item) => item.number === edge().via);
            return (
              <View
                role="button"
                onPress={() =>
                  props.onTask(ancestor()?.taskId ?? edge().taskId)
                }
                style={{
                  minHeight: 21,
                  cursor: "pointer",
                  justifyContent: "center",
                }}
              >
                <Label size={12} tone="blue">
                  {ancestor()
                    ? uiText("openParentTask", { via: edge().via })
                    : uiText("seeWhyWasCancelled", { number: edge().number })}
                </Label>
              </View>
            );
          }}
        </Each>
      </View>
    </If>
  );
}
export function Subtasks(props: {
  item: BoardTaskDetail;
  onTask: (id: string) => void;
}) {
  const c = colors();
  const children = () => props.item.children ?? [];
  const highlights = () =>
    [
      ["Now", children().find((item) => item.status === "in_progress")],
      ["Next", children().find((item) => item.status === "todo")],
      ["To review", children().find((item) => item.status === "in_review")],
    ] as const;
  return (
    <View style={{ gap: 7, marginTop: 4 }}>
      <Caption text={uiText("progress")} />
      <View style={{ ...row, gap: 3 }}>
        <Each
          of={children().filter((child) => child.status !== "cancelled")}
          key={(child) => child.taskId}
        >
          {(child) => (
            <View
              style={{
                height: 4,
                flex: 1,
                backgroundColor: [
                  "done",
                  "in_progress",
                  "in_review",
                  "blocked",
                ].includes(child().status)
                  ? c()[tones[child().status]]
                  : c().border,
              }}
            />
          )}
        </Each>
      </View>
      <If when={props.item.subtasks}>
        {(count) => (
          <Label size={12} tone="muted">
            {uiText("ofDoneTheParentDoesNo", {
              done: count().done,
              total: count().total,
            })}
          </Label>
        )}
      </If>
      <Each
        of={highlights().filter(([, item]) => !!item)}
        key={(entry) => entry[0]}
      >
        {(entry) => (
          <View style={{ ...row, gap: 8 }}>
            <Label size={12} tone="muted" style={{ width: 66 }}>
              {entry()[0]}
            </Label>
            <Label
              size={12}
              tone={entry()[0] === "To review" ? "amber" : "ink"}
            >
              {entry()[1]?.title}
            </Label>
          </View>
        )}
      </Each>
      <Caption text={uiText("subtasks")} />
      <Each of={children()} key={(child) => child.taskId}>
        {(child) => (
          <TaskLink
            onTask={props.onTask}
            item={child()}
            suffix={statusName(child().status)}
          />
        )}
      </Each>
    </View>
  );
}
