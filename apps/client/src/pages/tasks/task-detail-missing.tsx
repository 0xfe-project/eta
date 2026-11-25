import type { JSX } from "nsh";
import type { TaskDetailState } from "./task-detail-state";
import { EmptyState } from "../../components/empty-state";
import { uiText } from "../../i18n";

/**
 * A task's page while it has no task to show: its skeleton while it loads, what did not load and
 * Retry, or that it no longer exists (deleted here or elsewhere, or a link to one this host does
 * not have), with the way back. It never stays on the skeleton for ever.
 */
export function TaskDetailMissing(props: {
  state: TaskDetailState;
  skeleton: JSX.Element;
  onBack?: () => void;
}) {
  const load = props.state.load;
  // Not gone and nothing failed: the task is here or on its way, and the skeleton holds its
  // least time (#380) rather than saying anything.
  const status = () => {
    if (props.state.gone()) return "error" as const;
    const now = load.shown();
    return now === "empty" ? ("loading" as const) : now;
  };
  return (
    <EmptyState
      size="page"
      status={status()}
      loading={props.skeleton}
      error={
        props.state.gone()
          ? {
              art: "tasks",
              tone: "quiet",
              title: uiText("taskGone"),
              description: uiText("taskGoneHint"),
              actions: props.onBack
                ? [
                    {
                      label: uiText("backToTasks"),
                      icon: "arrowLeft",
                      onPress: props.onBack,
                    },
                  ]
                : undefined,
            }
          : {
              title: uiText("taskDidNotLoad"),
              description: load.why(),
              retry: load.retry,
              retrying: load.retrying(),
            }
      }
      empty={{ title: uiText("taskGone") }}
    />
  );
}
