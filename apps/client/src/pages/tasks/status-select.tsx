import type { BoardTaskDetail } from "@eta/client-contracts";
import type { TaskDetailState } from "./task-detail-state";
import { View } from "nsh";
import { Button, colors, Icon, inCompact, Label, row } from "../../components";
import { control, icon, space, weight } from "../../components/tokens";
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
/** The select at its narrowest, and its menu (an error under it runs as wide). */
const selectWidth = 128;
const menuWidth = 220;

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
  /** A change on its way: the trigger already shows it (`change`), only a second one waits. */
  const busy = () => changing() !== undefined;
  /** In the conversation panel: a 24px trigger with 12px glyphs. */
  const dense = inCompact();
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
          height: plain() || dense() ? control.sm : control.md,
          minWidth: plain() ? undefined : selectWidth,
          maxWidth: "100%",
          paddingHorizontal: space[8],
          gap: space[4],
          borderWidth: 1,
          borderColor: tint() ? c()[tones[props.item.status]] : c().strong,
          backgroundColor: tint() ? c()[tint()!] : c().canvas,
          cursor: busy() ? "default" : "pointer",
        }}
      >
        <If when={!plain()}>
          <TaskGlyph
            status={props.item.status}
            size={dense() ? icon.sm : icon.md}
          />
        </If>
        <Label
          variant={plain() ? "caption" : "small"}
          weight={plain() ? weight.strong : weight.regular}
          tone={ink()}
          lines={1}
          style={plain() ? undefined : { flex: 1, minWidth: 0 }}
        >
          {statusName(props.item.status)}
        </Label>
        <Icon
          name="down"
          size={plain() ? icon.sm : dense() ? icon.sm : icon.md}
          tone={ink()}
        />
      </View>
    );
  };
  return (
    <View
      style={{
        alignItems: props.align === "end" ? "flex-end" : "flex-start",
        gap: space[4],
        minWidth: 0,
        flexShrink: 1,
      }}
    >
      <If when={!props.state.phone()} else={<Trigger pressable />}>
        <TaskMenu
          width={menuWidth}
          align={props.align}
          caption={uiText("changeStatus")}
          dense
          open={status()}
          onOpenChange={(next) => (next ? open() : status.set(false))}
          trigger={<Trigger />}
        >
          <StatusOptions
            current={props.item.status}
            waiting={props.item.dependents?.length ?? 0}
            dense
            onChange={change}
          />
        </TaskMenu>
      </If>
      <If when={statusError()}>
        {(message) => (
          <View style={{ ...row, gap: space[4], maxWidth: menuWidth }}>
            <Label
              variant="caption"
              tone="red"
              lines={2}
              style={{ flex: 1, minWidth: 0 }}
            >
              {message()}
            </Label>
            <Button
              label={uiText("retry")}
              tone="ghost"
              labelTone="red"
              size={control.sm}
              onPress={props.state.retryStatus}
            />
          </View>
        )}
      </If>
    </View>
  );
}
