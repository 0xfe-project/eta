import type { MarketSettings, MarketSource } from "@eta/client-contracts";
import { effect, signal, untracked, View } from "nsh";
import { Input } from "nsh/base";
import {
  Button,
  colors,
  Empty,
  fontFamily,
  Fonts,
  grow,
  Label,
  row,
  SmoothScroll,
  textFaces,
  textStyle,
} from "../../components";
import { ToggleSwitch } from "../../components/toggle-switch";
import { control, space } from "../../components/tokens";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";
import { emptyStyle } from "./section";

/** An address the market may read: http or https, and not in the list already. */
function sourceProblem(
  address: string,
  sources: readonly MarketSource[],
): string | undefined {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return uiText("pluginsSourceInvalid");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    return uiText("pluginsSourceInvalid");
  if (sources.some((item) => item.url === address))
    return uiText("pluginsSourceDuplicate");
  return undefined;
}

/** The settings of the plugin market: where it reads plugins from, and the GitHub proxy. */
export function PluginSettings(props: { phone?: boolean }) {
  const host = useHost();
  const c = colors();
  const type = textFaces();
  const fonts = Fonts();
  const settings = signal<MarketSettings>();
  const name = signal("");
  const address = signal("");
  const proxy = signal("");
  const problem = signal("");
  const proxyProblem = signal("");
  const busy = signal(false);
  const sources = () => settings()?.sources ?? [];

  async function call(
    method: string,
    args: Record<string, unknown>,
  ): Promise<boolean> {
    if (busy()) return false;
    busy.set(true);
    const result = await host.action(() =>
      host.call<MarketSettings>("plugins", method, args),
    );
    busy.set(false);
    if (!result) return false;
    settings.set(result);
    proxy.set(result.proxy);
    return true;
  }
  effect(() => {
    host.subscriptionWire();
    untracked(() => void call("marketSettings", {}));
  });

  async function add() {
    const clean = address().trim();
    const found = sourceProblem(clean, sources());
    problem.set(found ?? "");
    if (found) return;
    if (await call("marketAddSource", { url: clean, name: name().trim() })) {
      name.set("");
      address.set("");
    }
  }
  async function saveProxy() {
    const clean = proxy().trim();
    if (clean !== "" && !/^https?:\/\/[^\s/]+/i.test(clean)) {
      proxyProblem.set(uiText("pluginsProxyInvalid"));
      return;
    }
    proxyProblem.set("");
    await call("marketSetProxy", { proxy: clean });
  }

  const field = (
    label: string,
    value: () => string,
    onChange: (value: string) => void,
    onSubmit?: () => void,
  ) => (
    <Input
      accessibilityLabel={label}
      placeholder={label}
      value={value()}
      submitBehavior="submit"
      onSubmit={onSubmit}
      onChange={(event) => onChange(event.value)}
      focusStyle={{ borderColor: c().ink }}
      style={{
        color: c().ink,
        placeholderColor: c().faint,
        backgroundColor: c().canvas,
        fontFamily: fontFamily(fonts().interface),
        ...textStyle(type("small")),
        height: props.phone ? space[40] : control.md,
        paddingHorizontal: props.phone ? space[12] : space[8],
        borderWidth: 1,
        borderColor: c().strong,
        borderRadius: 0,
      }}
    />
  );
  const inset = props.phone ? 16 : 24;
  return (
    <SmoothScroll style={grow} scrollbar={false}>
      <View
        style={{
          paddingHorizontal: inset,
          paddingTop: space[12],
          paddingBottom: space[16],
          gap: 14, // design-value: spacing between two steps of the scale, kept so the layout does not move
        }}
      >
        <Label weight={500}>{uiText("pluginsSourcesTitle")}</Label>
        <Label variant="small" tone="muted">
          {uiText("pluginsSourcesHint")}
        </Label>
        <If
          when={sources().length}
          else={
            <Empty
              title={uiText("pluginsNoSources")}
              description={uiText("pluginsNoSourcesHint")}
              icon="plugins"
              iconSize={24} // design-value: an empty state's icon, between icon.lg and icon.xl
              descriptionWidth={320} // design-value: the empty state's text wrap width
              style={{
                ...emptyStyle,
                paddingVertical: space[24],
                flexBasis: "auto",
              }}
            />
          }
        >
          <View style={{ borderWidth: 1, borderColor: c().border }}>
            <Each of={sources()} key={(item) => item.url}>
              {(item) => (
                <View
                  style={{
                    ...row,
                    gap: space[12],
                    padding: 10, // design-value: spacing between two steps of the scale, kept so the layout does not move
                    borderBottomWidth: 1,
                    borderColor: c().border,
                  }}
                >
                  <View style={{ flex: 1, minWidth: 0, gap: space[2] }}>
                    <Label lines={1}>{item().name || item().url}</Label>
                    <If when={item().name}>
                      <Label
                        variant="small"
                        tone="muted"
                        lines={1}
                        style={{ userSelect: "text" }}
                      >
                        {item().url}
                      </Label>
                    </If>
                  </View>
                  <ToggleSwitch
                    label={uiText("pluginsSourceEnabled", {
                      name: item().name || item().url,
                    })}
                    checked={item().enabled}
                    disabled={busy()}
                    onChange={(enabled) =>
                      void call("marketSetSourceEnabled", {
                        url: item().url,
                        enabled,
                      })
                    }
                  />
                  <Button
                    label={uiText("pluginsRemove")}
                    accessibilityLabel={uiText("pluginsRemoveSource", {
                      name: item().name || item().url,
                    })}
                    size={props.phone ? space[40] : control.md}
                    disabled={busy()}
                    onPress={() =>
                      void call("marketRemoveSource", { url: item().url })
                    }
                  />
                </View>
              )}
            </Each>
          </View>
        </If>
        {/* design-value: a cap of its own, not a token */}
        <View style={{ gap: space[8], maxWidth: 560 }}>
          {field(uiText("pluginsSourceName"), name, name.set)}
          {field(
            uiText("pluginsSourceUrl"),
            address,
            address.set,
            () => void add(),
          )}
          <If when={problem()}>
            <Label variant="small" tone="mutedInk">
              {problem()}
            </Label>
          </If>
          <View style={{ ...row, justifyContent: "flex-end" }}>
            <Button
              label={uiText("pluginsAddSource")}
              tone="primary"
              icon="plus"
              size={props.phone ? control.touch : control.md}
              disabled={busy()}
              onPress={() => void add()}
            />
          </View>
        </View>

        <Label weight={500} style={{ paddingTop: space[8] }}>
          {uiText("pluginsProxyTitle")}
        </Label>
        {/* design-value: a cap of its own, not a token */}
        <Label variant="small" tone="muted" style={{ maxWidth: 760 }}>
          {uiText("pluginsProxyHint")}
        </Label>
        {/* design-value: a cap of its own, not a token */}
        <View style={{ gap: space[8], maxWidth: 560 }}>
          {field(
            uiText("pluginsProxy"),
            proxy,
            proxy.set,
            () => void saveProxy(),
          )}
          <If when={proxyProblem()}>
            <Label variant="small" tone="mutedInk">
              {proxyProblem()}
            </Label>
          </If>
          <View style={{ ...row, justifyContent: "flex-end" }}>
            <Button
              label={uiText("pluginsProxySave")}
              size={props.phone ? control.touch : control.md}
              disabled={busy()}
              onPress={() => void saveProxy()}
            />
          </View>
        </View>
      </View>
    </SmoothScroll>
  );
}
