import type { ComposioPluginView, PluginResults } from "@eta/client-contracts";
import { effect, signal, untracked, View } from "nsh";
import { colors, Label, row } from "../../components";
import { hint } from "../../components/controls";
import { ToggleSwitch } from "../../components/toggle-switch";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";

/** The last list of each host, kept for as long as the host lives. */
const listed = new WeakMap<object, ComposioPluginView[]>();

/**
 * The connected Composio toolkits as the host lists them as plugins of the agents
 * (`@composio/<slug>`). Read once when the page opens and again on `read()`; a host that does not
 * answer (or does not know the call) lists none, and nothing says so.
 */
export function useComposioPlugins() {
  const host = useHost();
  // What this host last listed: a page that is shown again starts from it, not from an empty list.
  const list = signal<ComposioPluginView[]>(listed.get(host) ?? []);
  async function read() {
    const answer = await host
      .call<PluginResults["composioPlugins"]>("plugins", "composioPlugins", {})
      .catch(() => undefined);
    list.set(Array.isArray(answer?.plugins) ? answer.plugins : []);
  }
  effect(() => {
    listed.set(host, list());
  });
  effect(() => {
    untracked(() => void read());
  });
  return { list, read };
}

/**
 * The user's switch for one connected toolkit, for every agent: the same `setEnabled` and the same
 * words as any plugin's. A toolkit whose session did not check out has no switch; its card says why
 * in its badge. The block takes what the buttons beside it leave and no more: the words after the
 * switch are cut short when there is no room (the whole of them in the tooltip), so the row of the
 * card never wraps.
 */
/** The words after the switch: what is left of the row, cut short at its end. */
const WORDS = { flexShrink: 1, minWidth: 0, overflow: "hidden" } as const;

export function ComposioPluginSwitch(props: {
  view: ComposioPluginView;
  /** Called when the host has taken the switch, to read the list again. */
  onChanged: () => void;
}) {
  const host = useHost();
  const c = colors();
  const words = () =>
    props.view.enabled ? uiText("pluginSwitch") : uiText("pluginOffForAll");
  return (
    <If when={props.view.state === "ready"}>
      <View
        testID="composio-plugin-switch"
        tooltip={hint(words(), c)}
        style={{ ...row, gap: 8, flex: 1, minWidth: 0 }}
      >
        <View style={{ flexShrink: 0 }}>
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
        </View>
        <If
          when={props.view.enabled}
          else={
            <View testID="composio-plugin-off" style={WORDS}>
              <Label variant="caption" tone="muted" lines={1}>
                {words()}
              </Label>
            </View>
          }
        >
          <View style={WORDS}>
            <Label variant="caption" tone="muted" lines={1}>
              {words()}
            </Label>
          </View>
        </If>
      </View>
    </If>
  );
}
