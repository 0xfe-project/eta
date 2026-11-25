import type { MarketSettings, MarketSource } from "@eta/client-contracts";
import { effect, signal, untracked, View } from "nsh";
import {
  Button,
  colors,
  Field,
  grow,
  Label,
  row,
  SmoothScroll,
} from "../../components";
import { EmptyState } from "../../components/empty-state";
import { ToggleSwitch } from "../../components/toggle-switch";
import { control, space, weight } from "../../components/tokens";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";

/** How wide the source and proxy fields grow, and the hint above the proxy. */
const fieldWidth = 560;
const hintWidth = 760;

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
  const settings = signal<MarketSettings>();
  const name = signal("");
  const address = signal("");
  const proxy = signal("");
  const problem = signal("");
  const proxyProblem = signal("");
  const busy = signal(false);
  /** Whether the host holds a key; unknown (undefined) until it has said, which is not "no key". */
  const hasKey = signal<boolean>();
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
    if (await keyCall("composioSetKey", { key: clean })) {
      typedKey.set("");
      // The source is on only with a key: read the list again.
      await call("marketSettings", {});
    }
  }
  async function clearKey() {
    keyProblem.set("");
    if (await keyCall("composioClearKey", {})) {
      typedKey.set("");
      await call("marketSettings", {});
    }
  }
  /** Read only: it holds nothing busy, and it never overwrites what a save has said since. */
  async function readKey() {
    const result = await host.action(() =>
      host.call<{ hasKey: boolean }>("plugins", "composioStatus", {}),
    );
    if (result && hasKey() === undefined) hasKey.set(result.hasKey);
  }
  /** Whether the sources have been read: an empty list is "none" only once they were. */
  const read = signal<"loading" | "error" | "empty">("loading");
  const readSources = () => {
    read.set("loading");
    void call("marketSettings", {}).then((ok) => {
      read.set(ok ? "empty" : "error");
      if (ok && hasComposio()) void readKey();
    });
  };
  effect(() => {
    host.subscriptionWire();
    untracked(readSources);
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
    <Field
      label={label}
      placeholder={label}
      value={value()}
      compact
      onSubmit={onSubmit}
      onChange={onChange}
      style={
        props.phone
          ? { height: control.touch, paddingHorizontal: space[12] }
          : undefined
      }
    />
  );
  const inset = props.phone ? space[16] : space[24];
  return (
    <SmoothScroll style={grow} scrollbar={false}>
      <View
        style={{
          paddingHorizontal: inset,
          paddingTop: space[12],
          paddingBottom: space[16],
          gap: space[12],
        }}
      >
        <Label weight={weight.regular}>{uiText("pluginsSourcesTitle")}</Label>
        <Label variant="small" tone="muted">
          {uiText("pluginsSourcesHint")}
        </Label>
        <If
          when={sources().length}
          else={
            <EmptyState
              size="card"
              status={read()}
              loading={uiText("loadingPluginSources")}
              error={{
                title: uiText("pluginSourcesDidNotLoad"),
                retry: readSources,
              }}
              empty={{
                art: "plugins",
                title: uiText("pluginsNoSources"),
                description: uiText("pluginsNoSourcesHint"),
              }}
              style={{ borderWidth: 1, borderColor: c().border }}
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
                    padding: space[8],
                    borderBottomWidth: 1,
                    borderColor: c().border,
                  }}
                >
                  <View style={{ flex: 1, minWidth: 0, gap: space[2] }}>
                    <Label lines={1}>{item().name || item().url}</Label>
                    <If when={item().kind === "composio" && hasKey() === false}>
                      <Label variant="small" tone="muted" lines={1}>
                        {uiText("composioSourceNeedsKey")}
                      </Label>
                    </If>
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
                    disabled={
                      busy() ||
                      (item().kind === "composio" && hasKey() === false)
                    }
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
                      size={props.phone ? control.touch : control.md}
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
        <View style={{ gap: space[8], maxWidth: fieldWidth }}>
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

        <If when={hasComposio()}>
          <Label weight={weight.regular} style={{ paddingTop: space[8] }}>
            {uiText("composioKeyTitle")}
          </Label>
          {/* design-value: a cap of its own, not a token */}
          <View style={{ gap: space[8], maxWidth: 560 }}>
            <If when={hasKey() !== undefined}>
              <Label variant="small" weight={weight.regular}>
                {hasKey()
                  ? uiText("composioKeySet")
                  : uiText("composioKeyNone")}
              </Label>
            </If>
            <Field
              label={uiText("composioKeyField")}
              placeholder={uiText("composioKeyField")}
              value={typedKey()}
              masked
              onChange={typedKey.set}
              onSubmit={() => void saveKey()}
              style={{ height: props.phone ? space[40] : control.md }}
            />
            <If when={keyProblem()}>
              <Label variant="small" tone="mutedInk">
                {keyProblem()}
              </Label>
            </If>
            <View style={{ ...row, justifyContent: "flex-end", gap: space[8] }}>
              <If when={hasKey()}>
                <Button
                  label={uiText("composioKeyClear")}
                  size={props.phone ? control.touch : control.md}
                  disabled={busy()}
                  onPress={() => void clearKey()}
                />
              </If>
              <Button
                label={
                  hasKey()
                    ? uiText("composioKeyReplace")
                    : uiText("composioKeySave")
                }
                tone="primary"
                size={props.phone ? control.touch : control.md}
                disabled={busy()}
                onPress={() => void saveKey()}
              />
            </View>
          </View>
        </If>

        <Label weight={weight.regular} style={{ paddingTop: space[8] }}>
          {uiText("pluginsProxyTitle")}
        </Label>
        <Label variant="small" tone="muted" style={{ maxWidth: hintWidth }}>
          {uiText("pluginsProxyHint")}
        </Label>
        <If when={settings()}>
          <View style={{ gap: space[8], maxWidth: fieldWidth }}>
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
        </If>
      </View>
    </SmoothScroll>
  );
}
