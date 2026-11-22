import type { PluginView } from "@eta/client-contracts";
import { View } from "nsh";
import { colors, Label, row } from "../../components";
import { hint } from "../../components/context-ring";
import { ToggleSwitch } from "../../components/toggle-switch";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";

/** A plugin's name on a card, market or installed: one style, one line, the whole name on hover. */
export function PluginName(props: { name: string }) {
  const c = colors();
  return (
    <View tooltip={hint(props.name, c)} style={{ minWidth: 0 }}>
      <Label variant="subtitle" weight={600} lines={1}>
        {props.name}
      </Label>
    </View>
  );
}

/** The user's switch for one installed plugin, for every agent; not the market-source switch. */
export function PluginEnabled(props: { item: PluginView; compact?: boolean }) {
  const host = useHost();
  const c = colors();
  const words = () =>
    props.item.enabled ? uiText("pluginSwitch") : uiText("pluginOffForAll");
  return (
    <View
      tooltip={props.compact ? hint(words(), c) : undefined}
      style={{ ...row, gap: 8, flexShrink: 0 }}
    >
      <ToggleSwitch
        label={uiText("pluginSwitch")}
        checked={props.item.enabled}
        onChange={(enabled) =>
          void host.action(() =>
            host.call("plugins", "setEnabled", {
              name: props.item.name,
              enabled,
            }),
          )
        }
      />
      <If when={!props.compact}>
        <Label variant="caption" tone="muted" lines={1}>
          {words()}
        </Label>
      </If>
    </View>
  );
}
