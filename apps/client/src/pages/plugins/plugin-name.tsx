import type { PluginView } from "@eta/client-contracts";
import { effect, signal, View } from "nsh";
import { colors, Label, row } from "../../components";
import { hint } from "../../components/controls";
import {
  createOptimisticStatus,
  OptimisticStatus,
} from "../../components/optimistic-status";
import { ToggleSwitch } from "../../components/toggle-switch";
import { space, weight } from "../../components/tokens";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";

/** A plugin's name on a card, market or installed: one style, one line, the whole name on hover. */
export function PluginName(props: { name: string }) {
  const c = colors();
  return (
    <View tooltip={hint(props.name, c)} style={{ minWidth: 0 }}>
      <Label variant="subtitle" weight={weight.strong} lines={1}>
        {props.name}
      </Label>
    </View>
  );
}

/** The user's switch for one installed plugin, for every agent; not the market-source switch. */
export function PluginEnabled(props: { item: PluginView; compact?: boolean }) {
  const host = useHost();
  const c = colors();
  const pending = signal<boolean | undefined>(undefined);
  const status = createOptimisticStatus();
  let lastTarget: boolean | undefined;
  let turn = 0;
  effect(() => {
    if (pending() !== undefined && props.item.enabled === pending())
      pending.set(undefined);
  });
  const checked = () => pending() ?? props.item.enabled;
  const words = () =>
    checked() ? uiText("pluginSwitch") : uiText("pluginOffForAll");
  function apply(enabled: boolean) {
    const currentTurn = ++turn;
    lastTarget = enabled;
    pending.set(enabled);
    status.saving();
    void host
      .call("plugins", "setEnabled", {
        name: props.item.name,
        enabled,
      })
      .then(() => {
        if (turn !== currentTurn) return;
        status.saved();
        setTimeout(() => {
          if (turn === currentTurn) pending.set(undefined);
        }, 1500);
      })
      .catch((problem: unknown) => {
        if (turn !== currentTurn) return;
        pending.set(undefined);
        status.fail(
          problem instanceof Error ? problem.message : String(problem),
        );
      });
  }
  return (
    <View
      tooltip={props.compact ? hint(words(), c) : undefined}
      style={{ ...row, gap: space[8], flexShrink: 0 }}
    >
      <ToggleSwitch
        label={uiText("pluginSwitch")}
        checked={checked()}
        onChange={apply}
      />
      <If when={!props.compact && status.state().status === "idle"}>
        <Label variant="caption" tone="muted" lines={1}>
          {words()}
        </Label>
      </If>
      <If when={status.state().status !== "idle"}>
        <OptimisticStatus
          state={status.state()}
          onRetry={
            lastTarget !== undefined ? () => apply(lastTarget!) : undefined
          }
        />
      </If>
    </View>
  );
}
