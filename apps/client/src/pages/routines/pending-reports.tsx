import type { RoutineSummary } from "@eta/client-contracts";
import { Scroll, View } from "nsh";
import { Button, colors, grow, Label, Modal } from "../../components";
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
      <Scroll style={grow}>
        <View style={{ padding: 12, gap: 8 }}>
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
                  padding: 12,
                  gap: 5,
                  borderWidth: 1,
                  borderColor: c().border,
                }}
              >
                <Label size={11} tone="muted">
                  {uiText("routine", {
                    value1:
                      entry().run.status === "sent" ? "report" : "failure",
                    routineTime: routineTime(entry().run.startedAt),
                  })}
                </Label>
                <Label
                  size={13}
                >{`${entry().routine.name}: ${entry().run.title ?? "No report"}`}</Label>
                <Button
                  label={
                    entry().run.status === "sent"
                      ? uiText("openReport")
                      : uiText("viewRun")
                  }
                  tone="ghost"
                  style={{ alignSelf: "flex-start" }}
                  onPress={() => {
                    props.onOpen(entry().routine.id, entry().run.id);
                  }}
                />
              </View>
            )}
          </Each>
        </View>
      </Scroll>
    </Modal>
  );
}
