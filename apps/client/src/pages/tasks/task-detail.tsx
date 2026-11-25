import type { Layout } from "../../components";
import { signal, View } from "nsh";
import {
  Button,
  colors,
  grow,
  Header,
  Icon,
  Label,
  Modal,
  row,
} from "../../components";
import { settled } from "../../components/pending";
import { control, icon, space } from "../../components/tokens";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";
import { ArtifactPreview } from "../chat/artifacts/preview";
import { TaskMenu, TaskMenuItem } from "./menu";
import { TaskPlan } from "./plan";
import { activeTaskRun, latestExecutorRun } from "./run-log";
import { Segmented } from "./segmented";
import { TaskDetailSkeleton } from "./skeleton";
import { TaskDetailDialogs } from "./task-detail-dialogs";
import { TaskDetailMissing } from "./task-detail-missing";
import { createTaskDetailState } from "./task-detail-state";
import { TaskCommentBox, TaskReviewActions } from "./task-fields";
import { TaskOverview } from "./task-overview";
import { TaskTopBar } from "./top-bar";

/** The task's ⋯ menu and its rows. */
const menuWidth = 172;
const menuRowHeight = 32;

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
  /** The desktop page, which edits its title and description in place and
   * starts over from its rail. */
  const page = () => props.layout === "desktop" && !props.docked;
  /** Beside the task list on tablet: no way back, the list is there. */
  const paned = () => props.layout === "tablet" && !props.docked;
  const {
    archive,
    editing,
    editDescription,
    editTitle,
    panel,
    phone,
    plan,
    task,
  } = state;
  /** The phone's … sheet, titled with the task. */
  const more = signal(false);
  // The skeleton, once it appeared, stays its least time before the task (#380).
  const shown = settled(() => !!task());
  const parent = () => !!task()?.children?.length;
  const run = () => {
    const item = task();
    return item ? latestExecutorRun(item) : undefined;
  };
  /** The task's … actions. The desktop and tablet pages and the phone edit the
   * title and description in place, change status from the status itself and
   * start over from the run row, so their menu is mostly Archive. */
  const actions = () => {
    const item = task();
    if (!item) return [];
    const list: { label: string; run: () => void }[] = [];
    const inPlace = page() || paned() || phone();
    if (!inPlace || (page() && parent()))
      list.push({
        label: uiText("edit"),
        run: () => {
          editTitle.set(item.title);
          editDescription.set(item.description ?? "");
          editing.set(true);
        },
      });
    // The phone has no run row to start over from; it offers it here once the run has stopped.
    const startOver = phone()
      ? !!run() && !activeTaskRun(run()!)
      : !page() && !paned() && item.runs.length > 0;
    if (!parent() && startOver)
      list.push({
        label: uiText("rerun"),
        run: () =>
          void host.action(() =>
            host.call("tasks", "rerun", { taskId: props.id }),
          ),
      });
    list.push(
      item.archivedAt
        ? {
            label: uiText("unarchive"),
            run: () =>
              void host.action(() =>
                host.optimistic(props.id, { archivedAt: null }, () =>
                  host.call("tasks", "unarchive", { taskId: props.id }),
                ),
              ),
          }
        : { label: uiText("archive"), run: () => archive.set(true) },
    );
    return list;
  };
  /** The header's … button, filled muted while hovered or open. */
  const MoreTrigger = (trigger: { onPress?: () => void }) => (
    <View
      role={trigger.onPress ? "button" : undefined}
      accessibilityLabel={uiText("taskActions")}
      onPress={trigger.onPress}
      hoverStyle={{ backgroundColor: c().selected }}
      expandedStyle={{ backgroundColor: c().selected }}
      style={{
        ...row,
        justifyContent: "center",
        minWidth: space[32],
        height: control.lg,
        cursor: "pointer",
      }}
    >
      <Icon name="more" size={icon.md} />
    </View>
  );
  return (
    <View
      style={{ ...grow, position: "relative", backgroundColor: c().canvas }}
    >
      <If when={phone() && more() ? task() : undefined}>
        {(item) => (
          <Modal
            title={`#${item().number} ${item().title}`}
            phone
            sheet
            overPhoneNavigation
            onClose={() => more.set(false)}
          >
            <View style={{ paddingTop: space[4], paddingBottom: space[24] }}>
              <Each of={actions()} key={(action) => action.label}>
                {(action, index) => (
                  <View
                    role="button"
                    accessibilityLabel={action().label}
                    onPress={() => {
                      more.set(false);
                      action().run();
                    }}
                    activeStyle={{ backgroundColor: c().selectedSoft }}
                    style={{
                      ...row,
                      height: space[48],
                      paddingHorizontal: space[16],
                      borderBottomWidth: index() < actions().length - 1 ? 1 : 0,
                      borderColor: c().border,
                    }}
                  >
                    <Label style={{ flex: 1 }}>{action().label}</Label>
                  </View>
                )}
              </Each>
            </View>
          </Modal>
        )}
      </If>
      <If
        when={phone()}
        else={
          <Header
            title={
              props.docked
                ? task()
                  ? uiText("task", { number: task()?.number })
                  : "Task"
                : (task()?.title ?? "Task")
            }
            layout={props.layout}
            onBack={paned() ? undefined : props.onClose}
            inset={props.docked ? space[8] : paned() ? space[16] : undefined}
            end={paned() ? space[12] : undefined}
            titleVariant={
              props.layout === "desktop" && !props.docked ? "small" : undefined
            }
            backIcon={
              props.layout === "desktop" && !props.docked
                ? "arrowLeft"
                : undefined
            }
            backIconSize={
              props.layout === "desktop" && !props.docked ? icon.md : undefined
            }
          >
            <View style={{ flex: 1 }} />
            <If when={task()}>
              <If when={task()?.children?.length && (!paned() || plan())}>
                <Segmented
                  options={[
                    { value: "overview", label: uiText("overview") },
                    { value: "plan", label: uiText("plan") },
                  ]}
                  value={plan() ? "plan" : "overview"}
                  height={control.sm}
                  labelVariant="caption"
                  boldActive={!paned()}
                  paddingHorizontal={paned() ? space[8] : undefined}
                  strong={paned()}
                  onChange={(value) => plan.set(value === "plan")}
                />
                <View style={{ width: paned() ? 0 : space[8] }} />
              </If>
              <If when={paned()}>
                <Button
                  label={uiText("panel")}
                  icon="sidebar"
                  iconSize={icon.md}
                  labelVariant="caption"
                  onPress={() => panel.set(true)}
                />
              </If>
              <TaskMenu width={menuWidth} align="end" trigger={<MoreTrigger />}>
                <Each of={actions()} key={(action) => action.label}>
                  {(action) => (
                    <TaskMenuItem
                      label={action().label}
                      height={menuRowHeight}
                      onSelect={action().run}
                    />
                  )}
                </Each>
              </TaskMenu>
            </If>
          </Header>
        }
      >
        <TaskTopBar
          number={task()?.number}
          inset={space[16]}
          touch
          background="canvas"
          onBack={props.onClose}
        >
          <If when={task()}>
            <MoreTrigger onPress={() => more.set(true)} />
          </If>
        </TaskTopBar>
      </If>
      <If
        when={state.gone() || !shown() ? undefined : task()}
        else={
          <TaskDetailMissing
            state={state}
            skeleton={<TaskDetailSkeleton label={uiText("loadingTask")} />}
            onBack={props.onClose}
          />
        }
      >
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
                  padding: space[16],
                  gap: space[12],
                  borderTopWidth: 1,
                  borderColor: c().border,
                }}
              >
                <Label variant="small" tone="muted" style={{ flex: 1 }}>
                  {uiText("forYouToCheck2")}
                </Label>
                <TaskReviewActions state={state} />
              </View>
            </If>
            <If when={phone()}>
              <If
                when={
                  item().status === "in_review" &&
                  !item().archivedAt &&
                  !item().children?.length
                }
              >
                <View
                  style={{
                    paddingVertical: space[12],
                    paddingHorizontal: space[16],
                    gap: space[8],
                    borderTopWidth: 1,
                    borderColor: c().border,
                  }}
                >
                  <Label variant="caption" tone="muted">
                    {uiText("taskReviewLetsDependentsGo")}
                  </Label>
                  <TaskReviewActions state={state} />
                </View>
              </If>
              <TaskCommentBox state={state} />
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
      <If when={state.artifact()}>
        {(selection) => (
          <ArtifactPreview
            artifact={selection().artifact}
            initialVersion={selection().version}
            layout={props.layout}
            onClose={() => state.artifact.set(undefined)}
          />
        )}
      </If>
    </View>
  );
}
