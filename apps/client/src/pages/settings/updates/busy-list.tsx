import type { UpgradeBusy } from "@eta/client-contracts";
import { View } from "nsh";
import { Label } from "../../../components";
import { space } from "../../../components/tokens";
import { uiText } from "../../../i18n";

function busyLabels(work: readonly UpgradeBusy[]) {
  return [
    ...new Set(
      work.map(({ name, number, kind }) =>
        kind === "task"
          ? uiText("busyTaskUpdate", {
              number: number === undefined ? "" : ` #${number}`,
              name,
            })
          : uiText(
              kind === "routine" ? "busyRoutineUpdate" : "busyReplyUpdate",
              { name },
            ),
      ),
    ),
  ];
}

export function BusyList(props: {
  work: readonly UpgradeBusy[];
  label: string;
}) {
  return (
    <If when={props.work.length > 0}>
      <View style={{ gap: 1 }}>
        <Label variant="small">{props.label}</Label>
        <Each of={busyLabels(props.work)} key={(label) => label}>
          {(label) => (
            <Label
              variant="small"
              tone="muted"
              style={{ paddingLeft: space[16] }}
            >{`• ${label()}`}</Label>
          )}
        </Each>
      </View>
    </If>
  );
}
