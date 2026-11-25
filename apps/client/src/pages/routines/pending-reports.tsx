import type { RoutineSummary } from "@eta/client-contracts";
import { View } from "nsh";
import {
  colors,
  dialogWidth,
  focusRing,
  grow,
  Label,
  Modal,
  row,
  SmoothScroll,
} from "../../components";
import { EmptyState } from "../../components/empty-state";
import { StatusDot } from "../../components/status-dot";
import { space } from "../../components/tokens";
import { uiText } from "../../i18n";
import { routineTime } from "./schedule";

export function PendingReports(props: {
  routines: RoutineSummary[];
  onOpen: (routine: string, run: string) => void;
  onClose: () => void;
}) {
  const c = colors();
  const reports = () =>
    props.routines
      .flatMap((routine) =>
        routine.runs
          .filter((run) => run.status === "sent" || run.status === "failed")
          .slice(0, 3)
          .map((run) => ({ routine, run })),
      )
      .sort((a, b) => b.run.startedAt - a.run.startedAt);
  return (
    <Modal
      title={uiText("pending")}
      width={dialogWidth.sm}
      height="100%"
      side
      overPhoneNavigation
      blurBackdrop={false}
      onClose={props.onClose}
    >
      <SmoothScroll style={grow}>
        <View style={{ padding: space[12], gap: space[8] }}>
          <If when={!reports().length}>
            <EmptyState
              size="page"
              status="empty"
              loading={null}
              error={null}
              empty={{
                art: "done",
                title: uiText("noNewReports"),
                description: uiText("noNewReportsHint"),
              }}
              style={{
                paddingHorizontal: space[4],
                paddingVertical: space[16],
              }}
            />
          </If>
          <Each of={reports()} key={(entry) => entry.run.id}>
            {(entry) => (
              <View
                style={{
                  paddingVertical: space[12],
                  paddingHorizontal: space[12],
                  gap: space[4],
                  borderWidth: 1,
                  borderColor: c().strong,
                }}
              >
                <View style={{ ...row, gap: space[4] }}>
                  <StatusDot
                    color={entry().run.status === "sent" ? c().blue : c().red}
                  />
                  <Label variant="caption" tone="muted">
                    {uiText("routine", {
                      value1:
                        entry().run.status === "sent" ? "report" : "failure",
                      routineTime: routineTime(entry().run.startedAt),
                    })}
                  </Label>
                </View>
                <Label variant="small">{`${entry().routine.name}: ${entry().run.title ?? uiText("noReport")}`}</Label>
                <View
                  role="button"
                  accessibilityLabel={
                    entry().run.status === "sent"
                      ? uiText("openReport")
                      : uiText("viewRun")
                  }
                  onPress={() => {
                    props.onOpen(entry().routine.id, entry().run.id);
                  }}
                  focusVisibleStyle={focusRing(c(), "inset")}
                  style={{ alignSelf: "flex-start", cursor: "pointer" }}
                >
                  <Label
                    variant="caption"
                    tone="mutedInk"
                    style={{
                      textDecorationLine: "underline",
                      textDecorationThickness: 1,
                    }}
                  >
                    {entry().run.status === "sent"
                      ? uiText("openReport")
                      : uiText("viewRun")}
                  </Label>
                </View>
              </View>
            )}
          </Each>
        </View>
      </SmoothScroll>
    </Modal>
  );
}
