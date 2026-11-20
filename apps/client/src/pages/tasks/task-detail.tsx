import type { Layout } from "../../components";
import { View } from "nsh";
import {
  ActionItem,
  ActionMenu,
  Button,
  colors,
  Empty,
  grow,
  Header,
  Label,
  row,
} from "../../components";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";
import { TaskPlan } from "./plan";
import { Segmented } from "./segmented";
import { TaskDetailDialogs } from "./task-detail-dialogs";
import { createTaskDetailState } from "./task-detail-state";
import { TaskCommentBox, TaskReviewActions } from "./task-fields";
import { TaskOverview } from "./task-overview";

export function TaskDetail(props: {
  id: string;
  layout: Layout;
  docked?: boolean;
  onClose: () => void;
  onTask: (id: string) => void;
}) {
  const host = useHost();
  const c = colors();
  const state = createTaskDetailState(props);
  /** Beside the task list on tablet: no way back, the list is there. */
  const paned = () => props.layout === "tablet" && !props.docked;
  const {
    archive,
    canComment,
    editing,
    editDescription,
    editTitle,
    panel,
    phone,
    plan,
    status,
    task,
  } = state;
  return (
    <View
      style={{ ...grow, position: "relative", backgroundColor: c().canvas }}
    >
      <Header
        title={
          phone() || props.docked
            ? task()
              ? uiText("task", { number: task()?.number })
              : "Task"
            : (task()?.title ?? "Task")
        }
        layout={props.layout}
        onBack={paned() ? undefined : props.onClose}
        inset={props.docked ? 8 : paned() ? 16 : undefined}
      >
        <View style={{ flex: 1 }} />
        <If when={task()}>
          <If
            when={!phone() && task()?.children?.length && (!paned() || plan())}
          >
            <Segmented
              options={[
                { value: "overview", label: uiText("overview") },
                { value: "plan", label: uiText("plan") },
              ]}
              value={plan() ? "plan" : "overview"}
              height={paned() ? 20 : 22}
              labelSize={paned() ? 11 : 10}
              paddingHorizontal={paned() ? 8 : undefined}
              strong={paned()}
              onChange={(value) => plan.set(value === "plan")}
            />
            <View style={{ width: paned() ? 0 : 8 }} />
          </If>
          <If when={paned()}>
            <Button
              label={uiText("panel")}
              icon="sidebar"
              labelSize={11}
              onPress={() => panel.set(true)}
            />
          </If>
          <ActionMenu label={uiText("taskActions")}>
            <ActionItem
              label={uiText("edit")}
              onSelect={() => {
                editTitle.set(task()?.title ?? "");
                editDescription.set(task()?.description ?? "");
                editing.set(true);
              }}
            />
            <If when={phone() && !task()?.children?.length}>
              <ActionItem
                label={uiText("changeStatus")}
                onSelect={() => status.set(true)}
              />
            </If>
            <If when={!task()?.children?.length && task()?.runs.length}>
              <ActionItem
                label={uiText("rerun")}
                onSelect={() =>
                  void host.action(() =>
                    host.call("tasks", "rerun", { taskId: props.id }),
                  )
                }
              />
            </If>
            <ActionItem
              label={
                task()?.archivedAt ? uiText("unarchive") : uiText("archive")
              }
              onSelect={() => {
                if (task()?.archivedAt)
                  void host.action(() =>
                    host.call("tasks", "unarchive", { taskId: props.id }),
                  );
                else archive.set(true);
              }}
            />
          </ActionMenu>
        </If>
      </Header>
      <If when={task()} else={<Empty title={uiText("loadingTask")} />}>
        {(item) => (
          <>
            <If
              when={!phone() && plan() && item().children?.length}
              else={
                <TaskOverview
                  item={item()}
                  layout={props.layout}
                  docked={props.docked}
                  onTask={props.onTask}
                  state={state}
                />
              }
            >
              <TaskPlan
                task={item}
                onOpen={props.onTask}
                desktop={props.layout === "desktop"}
                tablet={props.layout === "tablet" && !props.docked}
              />
            </If>
            <If
              when={
                props.layout === "tablet" &&
                !props.docked &&
                !plan() &&
                item().status === "in_review" &&
                !item().children?.length &&
                !item().archivedAt
              }
            >
              <View
                style={{
                  ...row,
                  justifyContent: "space-between",
                  padding: 14,
                  gap: 12,
                  borderTopWidth: 1,
                  borderColor: c().border,
                }}
              >
                <Label size={12} tone="muted" style={{ flex: 1 }}>
                  {uiText("forYouToCheck2")}
                </Label>
                <TaskReviewActions state={state} />
              </View>
            </If>
            <If
              when={phone() && !item().archivedAt && !item().children?.length}
            >
              <If when={item().status === "in_review"}>
                <View
                  style={{
                    borderTopWidth: 1,
                    borderColor: c().border,
                    paddingTop: 9,
                  }}
                >
                  <Label
                    size={11}
                    tone="muted"
                    style={{ paddingHorizontal: 16 }}
                  >
                    {uiText("acceptTheResultOrSendIt")}
                  </Label>
                  <TaskReviewActions state={state} />
                </View>
              </If>
              <If when={canComment(item())}>
                <View
                  style={{
                    padding: 12,
                    borderTopWidth: 1,
                    borderColor: c().border,
                  }}
                >
                  <TaskCommentBox state={state} />
                </View>
              </If>
            </If>
          </>
        )}
      </If>
      <TaskDetailDialogs
        id={props.id}
        layout={props.layout}
        onClose={props.onClose}
        state={state}
      />
    </View>
  );
}
