import type { MarketSettings, MarketSource } from "@eta/client-contracts";
import { effect, signal, untracked, View } from "nsh";
import { Input } from "nsh/base";
import {
  Button,
  colors,
  Empty,
  Field,
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
  const hasKey = signal(false);
  const typedKey = signal("");
  const keyProblem = signal("");
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
  const hasComposio = () => sources().some((item) => item.kind === "composio");
  /** The key is written and never read back: the host only says whether one is set. */
  async function keyCall(method: string, args: Record<string, unknown>) {
    if (busy()) return;
    busy.set(true);
    const result = await host.action(() =>
      host.call<{ hasKey: boolean }>("plugins", method, args),
    );
    busy.set(false);
    if (result) hasKey.set(result.hasKey);
    return result;
  }
  async function saveKey() {
    const clean = typedKey().trim();
    if (clean === "") {
      keyProblem.set(uiText("composioKeyEmpty"));
      return;
    }
    keyProblem.set("");
    if (await keyCall("composioSetKey", { key: clean })) typedKey.set("");
  }
  async function clearKey() {
    keyProblem.set("");
    if (await keyCall("composioClearKey", {})) typedKey.set("");
  }
  effect(() => {
    host.subscriptionWire();
    untracked(() => {
      void call("marketSettings", {}).then((ok) => {
        if (ok && hasComposio()) void keyCall("composioStatus", {});
      });
    });
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
        height: props.phone ? 40 : 28,
        paddingHorizontal: props.phone ? 12 : 8,
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
          paddingTop: 12,
          paddingBottom: 16,
          gap: 14,
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
              iconSize={24}
              descriptionWidth={320}
              style={{ ...emptyStyle, paddingVertical: 24, flexBasis: "auto" }}
            />
          }
        >
          <View style={{ borderWidth: 1, borderColor: c().border }}>
            <Each of={sources()} key={(item) => item.url}>
              {(item) => (
                <View
                  style={{
                    ...row,
                    gap: 12,
                    padding: 10,
                    borderBottomWidth: 1,
                    borderColor: c().border,
                  }}
                >
                  <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                    <Label lines={1}>{item().name || item().url}</Label>
                    <If when={item().name && item().kind !== "composio"}>
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
                  <If when={item().kind !== "composio"}>
                  <Button
                    label={uiText("pluginsRemove")}
                    accessibilityLabel={uiText("pluginsRemoveSource", {
                      name: item().name || item().url,
                    })}
                    size={props.phone ? 40 : 28}
                    disabled={busy()}
                    onPress={() =>
                      void call("marketRemoveSource", { url: item().url })
                    }
                  />
                  </If>
                </View>
              )}
            </Each>
          </View>
        </If>
        <View style={{ gap: 8, maxWidth: 560 }}>
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
              size={props.phone ? 44 : 28}
              disabled={busy()}
              onPress={() => void add()}
            />
          </View>
        </View>

        <If when={hasComposio()}>
          <Label weight={500} style={{ paddingTop: 8 }}>
            {uiText("composioKeyTitle")}
          </Label>
          <Label variant="small" tone="muted" style={{ maxWidth: 760 }}>
            {uiText("composioKeyHint")}
          </Label>
          <View style={{ gap: 8, maxWidth: 560 }}>
            <Label variant="small" weight={500}>
              {hasKey() ? uiText("composioKeySet") : uiText("composioKeyNone")}
            </Label>
            <Field
              label={uiText("composioKeyField")}
              placeholder={uiText("composioKeyField")}
              value={typedKey()}
              masked
              onChange={typedKey.set}
              onSubmit={() => void saveKey()}
              style={{ height: props.phone ? 40 : 28 }}
            />
            <If when={keyProblem()}>
              <Label variant="small" tone="mutedInk">
                {keyProblem()}
              </Label>
            </If>
            <View style={{ ...row, justifyContent: "flex-end", gap: 8 }}>
              <If when={hasKey()}>
                <Button
                  label={uiText("composioKeyClear")}
                  size={props.phone ? 44 : 28}
                  disabled={busy()}
                  onPress={() => void clearKey()}
                />
              </If>
              <Button
                label={hasKey() ? uiText("composioKeyReplace") : uiText("composioKeySave")}
                tone="primary"
                size={props.phone ? 44 : 28}
                disabled={busy()}
                onPress={() => void saveKey()}
              />
            </View>
          </View>
        </If>

        <Label weight={500} style={{ paddingTop: 8 }}>
          {uiText("pluginsProxyTitle")}
        </Label>
        <Label variant="small" tone="muted" style={{ maxWidth: 760 }}>
          {uiText("pluginsProxyHint")}
        </Label>
        <View style={{ gap: 8, maxWidth: 560 }}>
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
              size={props.phone ? 44 : 28}
              disabled={busy()}
              onPress={() => void saveProxy()}
            />
          </View>
        </View>
      </View>
    </SmoothScroll>
  );
}
