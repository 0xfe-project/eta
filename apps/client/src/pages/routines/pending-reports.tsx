import type { RoutineSummary } from "@eta/client-contracts";
import { View } from "nsh";
import {
  colors,
  grow,
  Label,
  Modal,
  row,
  SmoothScroll,
} from "../../components";
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
  return (
    <Modal
      title={uiText("pending")}
      width={360}
      height="100%"
      side
      overPhoneNavigation
      blurBackdrop={false}
      onClose={props.onClose}
    >
      <SmoothScroll style={grow}>
        <View style={{ padding: space[12], gap: space[8] }}>
          <Each
            of={props.routines
              .flatMap((routine) =>
                routine.runs
                  .filter(
                    (run) => run.status === "sent" || run.status === "failed",
                  )
                  .slice(0, 3)
                  .map((run) => ({ routine, run })),
              )
              .sort((a, b) => b.run.startedAt - a.run.startedAt)}
            key={(entry) => entry.run.id}
          >
            {(entry) => (
              <View
                style={{
                  paddingVertical: 10,
                  paddingHorizontal: space[12],
                  gap: 6,
                  borderWidth: 1,
                  borderColor: c().strong,
                }}
              >
                <View style={{ ...row, gap: 6 }}>
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
                <Label variant="small">{`${entry().routine.name}: ${entry().run.title ?? "No report"}`}</Label>
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
                  focusVisibleStyle={{
                    outlineWidth: 1,
                    outlineColor: c().blue,
                  }}
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
