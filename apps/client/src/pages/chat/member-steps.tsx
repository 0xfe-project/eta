import type { StoredTask, TaskStatus } from "@eta/client-contracts";
import { View } from "nsh";
import { Button, colors, focusRing, Label, row } from "../../components";
import { icon, space } from "../../components/tokens";
import { uiText } from "../../i18n";
import { follow, useHost } from "../../services/host";

const statuses: Record<
  TaskStatus,
  { mark: string; label: Parameters<typeof uiText>[0] }
> = {
  pending: { mark: "·", label: "pending" },
  in_progress: { mark: "▸", label: "taskInProgress" },
  completed: { mark: "✓", label: "taskCompleted" },
  cancelled: { mark: "×", label: "taskCancelled" },
};

export function MemberStepsToggle(props: {
  session: string;
  open: boolean;
  onToggle: () => void;
}) {
  const host = useHost();
  const target = () => `sessions.${props.session}`;
  follow(target);
  const steps = () => host.list<StoredTask>(target(), "tasks");
  const count = () =>
    steps().filter((step) => step.status === "completed").length;
  const c = colors();
  return (
    <View
      role="button"
      accessibilityState={{ expanded: props.open }}
      onPress={props.onToggle}
      focusVisibleStyle={focusRing(c(), "inset")}
      hoverStyle={{ backgroundColor: c().selected }}
      style={{
        ...row,
        height: space[24],
        paddingHorizontal: space[8],
        flexShrink: 0,
        borderWidth: 1,
        borderColor: props.open ? c().ink : c().border,
        backgroundColor: c().canvas,
        cursor: "pointer",
      }}
    >
      <Label variant="caption" tone={props.open ? "ink" : "muted"}>
        {uiText("stepCount", { completed: count(), total: steps().length })}
      </Label>
    </View>
  );
}

export function MemberStepsLedger(props: { session: string }) {
  const host = useHost();
  const c = colors();
  const target = () => `sessions.${props.session}`;
  const steps = () => host.section<StoredTask[]>(target(), "tasks");
  const online = () => host.state().status === "open";
  return (
    <View
      style={{
        paddingHorizontal: space[12],
        paddingVertical: space[4],
        backgroundColor: c().surface,
      }}
    >
      <If when={!online()}>
        <View style={{ ...row, gap: space[8] }}>
          <Label variant="caption" tone="muted" style={{ flex: 1 }}>
            {uiText("runReconnectStatus")}
          </Label>
          <Button
            label={uiText("retry")}
            tone="ghost"
            onPress={host.reconnect}
          />
        </View>
      </If>
      <If
        when={!!steps()?.length}
        else={
          <Label
            variant="small"
            tone="muted"
            style={{ paddingVertical: space[4] }}
          >
            {host.state().missing[target()]
              ? uiText("sessionUnavailable")
              : !steps()
                ? online()
                  ? uiText("stepLoading")
                  : uiText("offlineRunSteps")
                : uiText("noRunSteps")}
          </Label>
        }
      >
        <Each of={steps() ?? []} key={(step) => step.id}>
          {(step) => (
            <View
              role="text"
              accessible
              accessibilityLabel={`${uiText(statuses[step().status].label)} · ${step().content}`}
              style={{ ...row, height: space[24], gap: space[4] }}
            >
              <View
                style={{
                  ...row,
                  justifyContent: "center",
                  width: icon.md,
                  height: icon.md,
                  borderWidth: 1,
                  borderColor: c().border,
                  backgroundColor: c().canvas,
                }}
              >
                <Label variant="caption">{statuses[step().status].mark}</Label>
              </View>
              <Label variant="small" lines={1} style={{ flex: 1, minWidth: 0 }}>
                {step().content}
              </Label>
            </View>
          )}
        </Each>
      </If>
    </View>
  );
}
