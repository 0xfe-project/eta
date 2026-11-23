import type { ComposioPluginView, PluginResults } from "@eta/client-contracts";
import { effect, signal, untracked, View } from "nsh";
import { Label, row } from "../../components";
import { ToggleSwitch } from "../../components/toggle-switch";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";

/**
 * The connected Composio toolkits as the host lists them as plugins of the agents
 * (`@composio/<slug>`). Read once when the page opens and again on `read()`; a host that does not
 * answer (or does not know the call) lists none, and nothing says so.
 */
export function useComposioPlugins() {
  const host = useHost();
  const list = signal<ComposioPluginView[]>([]);
  async function read() {
    const answer = await host
      .call<PluginResults["composioPlugins"]>("plugins", "composioPlugins", {})
      .catch(() => undefined);
    list.set(Array.isArray(answer?.plugins) ? answer.plugins : []);
  }
  effect(() => {
    untracked(() => void read());
  });
  return { list, read };
}

/**
 * The user's switch for one connected toolkit, for every agent: the same `setEnabled` and the same
 * words as any plugin's. A toolkit whose session did not check out has no switch and says why.
 */
export function ComposioPluginSwitch(props: {
  view: ComposioPluginView;
  /** Called when the host has taken the switch, to read the list again. */
  onChanged: () => void;
}) {
  const host = useHost();
  const words = () =>
    props.view.enabled ? uiText("pluginSwitch") : uiText("pluginOffForAll");
  return (
    <If
      when={props.view.state === "ready"}
      else={
        <View testID="composio-plugin-error" style={{ flexShrink: 1 }}>
          <Label variant="caption" tone="muted">
            {uiText("composioPluginError")}
          </Label>
        </View>
      }
    >
      <View
        testID="composio-plugin-switch"
        style={{ ...row, gap: 8, flexShrink: 0 }}
      >
        <ToggleSwitch
          label={uiText("composioPluginSwitch", { name: props.view.name })}
          checked={props.view.enabled}
          onChange={(enabled) =>
            void host
              .action(() =>
                host.call("plugins", "setEnabled", {
                  name: props.view.name,
                  enabled,
                }),
              )
              .then(props.onChanged)
          }
        />
        <If
          when={props.view.enabled}
          else={
            <View testID="composio-plugin-off">
              <Label variant="caption" tone="muted" lines={1}>
                {words()}
              </Label>
            </View>
          }
        >
          <Label variant="caption" tone="muted" lines={1}>
            {words()}
          </Label>
        </If>
      </View>
    </If>
  );
}
