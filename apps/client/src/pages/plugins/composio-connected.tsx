import type { PluginResults } from "@eta/client-contracts";
import type { Layout } from "../../components";
import { effect, openUrl, signal, untracked, View } from "nsh";
import { Button, colors, Label, row, textFaces } from "../../components";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";
import { ComposioDisconnect, linkAndOpen } from "./composio-actions";
import { ComposioPluginSwitch, useComposioPlugins } from "./composio-plugins";
import { PluginLogo } from "./plugin-logo";
import { PluginName } from "./plugin-name";

interface Connected {
  slug: string;
  name: string;
  description: string;
}

/**
 * The Composio toolkits the user connected on Composio, under the installed plugins. Each is a plugin
 * of the agents too (`@composio/<slug>`): its card has the user's switch for every agent, and a
 * toolkit whose session did not check out says so instead. The names and
 * pictures come from the list the host already keeps (never asked for from the network here); a
 * toolkit that is not in it is shown by its slug. When Composio cannot be asked (no key, a refused
 * key, no answer) the group is not there, and nothing says why. Each item can be signed in again or
 * disconnected on Composio (the same two operations the market's detail has) while the key is set and
 * the source is on.
 */
export function ComposioConnected(props: {
  layout: Layout;
  /** Opens an address in the browser; the system's by default. */
  open?: (url: string) => Promise<void>;
}) {
  const host = useHost();
  const c = colors();
  const type = textFaces();
  const shown = signal<Connected[]>([]);
  /** Whether Re-authenticate and Disconnect show: a key is set and the source is not switched off. */
  const manage = signal(false);
  const disconnecting = signal<Connected | undefined>(undefined);
  const error = signal("");
  const plugins = useComposioPlugins();
  const viewOf = (slug: string) =>
    plugins.list().find((one) => one.slug === slug);
  async function reauth(slug: string) {
    error.set("");
    try {
      await linkAndOpen(host, props.open ?? openUrl, slug);
    } catch (cause) {
      error.set(cause instanceof Error ? cause.message : String(cause));
    }
  }
  function disconnected(slug: string) {
    // Gone at once; the host is asked again behind it.
    shown.update((all) => all.filter((one) => one.slug !== slug));
    disconnecting.set(undefined);
    void read();
    void plugins.read();
  }
  async function read() {
    const answer = await host
      .call<PluginResults["composioConnected"]>(
        "plugins",
        "composioConnected",
        {},
      )
      .catch(() => undefined);
    if (
      answer?.status !== "ready" ||
      !Array.isArray(answer.slugs) ||
      answer.slugs.length === 0
    )
      return;
    const status = await host
      .call<PluginResults["composioStatus"]>("plugins", "composioStatus", {})
      .catch(() => undefined);
    manage.set(status?.enabled === true);
    const kept = await host
      .call<PluginResults["composioToolkits"]>("plugins", "composioToolkits", {
        slugs: answer.slugs,
      })
      .catch(() => undefined);
    const known = new Map(
      (Array.isArray(kept?.toolkits) ? kept.toolkits : []).map((item) => [
        item.slug,
        item,
      ]),
    );
    shown.set(
      answer.slugs.map((slug) => ({
        slug,
        name: known.get(slug)?.name ?? slug,
        description: known.get(slug)?.description ?? "",
      })),
    );
  }
  effect(() => {
    untracked(() => void read());
  });
  const rows = () => props.layout !== "desktop";
  const actions = (item: Connected) => (
    <If when={manage()}>
      <View style={{ ...row, flexGrow: 1, justifyContent: "flex-end", gap: 8 }}>
        <Button
          label={uiText("composioReconnect")}
          tone="plain"
          size={rows() ? 32 : 24}
          onPress={() => void reauth(item.slug)}
        />
        <Button
          label={uiText("composioDisconnect")}
          tone="plain"
          size={rows() ? 32 : 24}
          onPress={() => disconnecting.set(item)}
        />
      </View>
    </If>
  );
  const inset = () => (props.layout === "tablet" ? 14 : 16);
  /**
   * The last line of a card: the connected mark at the left, the buttons at the right. When both
   * do not fit on one line the buttons drop to the next line and stay at the right.
   */
  const footer = (item: Connected) => (
    <View
      style={{
        ...row,
        flexWrap: "wrap",
        alignItems: "center",
        gap: 8,
        minHeight: type("small").line,
      }}
    >
      <If when={viewOf(item.slug)}>
        {(view) => (
          <View style={{ flexShrink: 1, minWidth: 0 }}>
            <ComposioPluginSwitch view={view()} onChanged={plugins.read} />
          </View>
        )}
      </If>
      {actions(item)}
    </View>
  );
  /** The connected mark, at the top right of a card, on the line of the name. */
  const mark = () => (
    <View testID="composio-connected" style={{ flexShrink: 0 }}>
      <Label variant="small" tone="muted" lines={1}>
        {uiText("composioConnected")}
      </Label>
    </View>
  );
  /** A card the user switched off for every agent is shown one step fainter. */
  const faint = (item: Connected) => ({
    opacity: viewOf(item.slug)?.enabled === false ? 0.55 : 1,
  });
  return (
    <If when={shown().length}>
      <View testID="composio-connected-group" style={{ gap: rows() ? 0 : 8 }}>
        <View
          style={{
            gap: 2,
            paddingHorizontal: rows() ? inset() : 0,
            paddingTop: rows() ? 16 : 0,
            paddingBottom: rows() ? 6 : 0,
            borderBottomWidth: rows() ? 1 : 0,
            borderColor: c().border,
          }}
        >
          <Label variant="small">
            {uiText("composioConnectedGroup", { count: shown().length })}
          </Label>
          <Label variant="caption" tone="muted">
            {uiText("composioConnectedGroupNote")}
          </Label>
          <If when={error()}>
            <Label variant="small" tone="red" style={{ userSelect: "text" }}>
              {error()}
            </Label>
          </If>
        </View>
        <If when={disconnecting()}>
          <ComposioDisconnect
            slug={disconnecting()!.slug}
            name={disconnecting()!.name}
            phone={props.layout === "phone"}
            onDone={() => disconnected(disconnecting()!.slug)}
            onClose={() => disconnecting.set(undefined)}
          />
        </If>
        <If
          when={rows()}
          else={
            <View
              style={{
                ...row,
                flexWrap: "wrap",
                alignItems: "flex-start",
                gap: 12,
              }}
            >
              <Each of={shown()} key={(item) => item.slug}>
                {(item) => (
                  <View
                    testID="composio-connected-item"
                    accessibilityLabel={item().name}
                    style={{
                      ...faint(item()),
                      width: 267,
                      padding: 12,
                      gap: 6,
                      backgroundColor: c().canvas,
                      borderWidth: 1,
                      borderColor: c().border,
                    }}
                  >
                    <View style={{ ...row, gap: 8 }}>
                      <PluginLogo name={item().name} composio={item().slug} />
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <PluginName name={item().name} />
                      </View>
                      {mark()}
                    </View>
                    <Label variant="small" tone="muted" lines={2}>
                      {item().description}
                    </Label>
                    {footer(item())}
                  </View>
                )}
              </Each>
            </View>
          }
        >
          <View>
            <Each of={shown()} key={(item) => item.slug}>
              {(item) => (
                <View
                  testID="composio-connected-item"
                  accessibilityLabel={item().name}
                  style={{
                    ...faint(item()),
                    borderBottomWidth: 1,
                    borderColor: c().border,
                    backgroundColor: c().canvas,
                  }}
                >
                  <View
                    style={{
                      ...row,
                      height: 60,
                      gap: 12,
                      paddingLeft: inset(),
                      paddingRight: 12,
                    }}
                  >
                    <PluginLogo
                      name={item().name}
                      composio={item().slug}
                      size={32}
                    />
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <PluginName name={item().name} />
                    </View>
                    {mark()}
                  </View>
                  <View
                    style={{
                      paddingLeft: inset(),
                      paddingRight: 12,
                      paddingBottom: 10,
                    }}
                  >
                    {footer(item())}
                  </View>
                </View>
              )}
            </Each>
          </View>
        </If>
      </View>
    </If>
  );
}
