import type { BoardTaskDetail } from "@eta/client-contracts";
import type { TaskDetailState } from "./task-detail-state";
import { View } from "nsh";
import { colors, Icon, Label, row } from "../../components";
import { uiText } from "../../i18n";
import { StatusOptions, TaskMenu } from "./menu";
import { statusName, TaskGlyph, tones } from "./status";

/** The statuses whose trigger is tinted in their colour: running, waiting for review, done. */
const statusFill = {
  in_progress: "blueFill",
  in_review: "warningFill",
  done: "greenFill",
} as const;

/**
 * Where a task's status is changed, on its page (the desktop rail, the tablet
 * header) and in the conversation panel: the status as a 28px trigger, tinted
 * in its colour while it runs, waits for review or is done, that opens the
 * "Change status" popover, the seven with a hint under each (on a phone the
 * page's "Change status" sheet, the same seven). The keyboard
 * opens it from the focused trigger (Return, Space, Down), moves with the
 * arrows, chooses with Return and closes with Escape. While a change is on
 * its way the trigger is dimmed and takes no presses; a change that fails
 * says why under it.
 */
export function StatusSelect(props: {
  item: BoardTaskDetail;
  state: TaskDetailState;
  /** The trigger's edge the popover lines up with: `"end"` where it sits at the right. */
  align?: "start" | "end";
  /** The tablet header's: an untinted status is a plain 22px label. */
  compact?: boolean;
}) {
  const c = colors();
  const { change, changing, status, statusError } = props.state;
  const tint = () =>
    statusFill[props.item.status as keyof typeof statusFill] as
      | (typeof statusFill)[keyof typeof statusFill]
      | undefined;
  const plain = () => !!props.compact && !tint();
  const ink = () => (tint() ? tones[props.item.status] : "ink");
  const busy = () => changing() !== undefined;
  const open = () => {
    statusError.set("");
    status.set(true);
  };
  /** The status itself; on a phone it opens the page's "Change status" sheet (`TaskDetailDialogs`). */
  const Trigger = (trigger: { pressable?: boolean }) => {
    const pressable = trigger.pressable;
    return (
      <View
        role={pressable ? "button" : undefined}
        accessibilityLabel={uiText("changeStatus")}
        accessibilityValue={{ text: statusName(props.item.status) }}
        accessibilityState={{ busy: busy() }}
        disabled={busy()}
        onPress={pressable ? open : undefined}
        style={{
          ...row,
          height: plain() ? 22 : 28,
          minWidth: plain() ? undefined : 128,
          maxWidth: "100%",
          paddingHorizontal: 8,
          gap: 6,
          borderWidth: 1,
          borderColor: tint() ? c()[tones[props.item.status]] : c().strong,
          backgroundColor: tint() ? c()[tint()!] : c().canvas,
          opacity: busy() ? 0.6 : 1,
          cursor: busy() ? "default" : "pointer",
        }}
      >
        <If when={!plain()}>
          <TaskGlyph status={props.item.status} size={14} />
        </If>
        <Label
          variant={plain() ? "caption" : "small"}
          weight={plain() ? 600 : 400}
          tone={ink()}
          lines={1}
          style={plain() ? undefined : { flex: 1, minWidth: 0 }}
        >
          {statusName(props.item.status)}
        </Label>
        <Icon name="down" size={plain() ? 10 : 14} tone={ink()} />
      </View>
    );
  };
  return (
    <View
      style={{
        alignItems: props.align === "end" ? "flex-end" : "flex-start",
        gap: 4,
        minWidth: 0,
        flexShrink: 1,
      }}
    >
      <If when={!props.state.phone()} else={<Trigger pressable />}>
        <TaskMenu
          width={264}
          align={props.align}
          caption={uiText("changeStatus")}
          open={status()}
          onOpenChange={(next) => (next ? open() : status.set(false))}
          trigger={<Trigger />}
        >
          <StatusOptions
            current={props.item.status}
            waiting={props.item.dependents?.length ?? 0}
            onChange={change}
          />
        </TaskMenu>
      </If>
      <If when={statusError()}>
        {(message) => (
          <Label
            variant="caption"
            tone="red"
            lines={2}
            style={{ maxWidth: 264 }}
          >
            {message()}
          </Label>
        )}
      </If>
    </View>
  );
}
