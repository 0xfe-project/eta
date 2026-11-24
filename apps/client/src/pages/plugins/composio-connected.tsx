import type { PluginResults } from "@eta/client-contracts";
import type { Layout } from "../../components";
import { effect, openUrl, signal, untracked, View } from "nsh";
import { Button, colors, Label, row } from "../../components";
import { hint } from "../../components/controls";
import { avatar, control, space } from "../../components/tokens";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";
import { ComposioDisconnect, linkAndOpen } from "./composio-actions";
import { ComposioPluginSwitch, useComposioPlugins } from "./composio-plugins";
import { PluginLogo } from "./plugin-logo";
import { PluginName } from "./plugin-name";
import { authStyle } from "./plugin-status";

interface Connected {
  slug: string;
  name: string;
  description: string;
  /** A toolkit that needs no sign-in and was added: no account, only Remove. */
  added?: boolean;
}

/** The last cards and the manage flag of each host, kept for as long as the host lives. */
const remembered = new WeakMap<
  object,
  { shown: Connected[]; manage: boolean }
>();

/**
 * The Composio toolkits the user connected on Composio, under the installed plugins. Each is a plugin
 * of the agents too (`@composio/<slug>`): its card has the user's switch for every agent, and a
 * toolkit whose session did not check out says so instead. The names and
 * pictures come from the list the host already keeps (never asked for from the network here); a
 * toolkit that is not in it is shown by its slug. When Composio cannot be asked (no key, a refused
 * key, no answer) the group is not there, and nothing says why. Each item can be signed in again or
 * disconnected on Composio (the same two operations the market's detail has) while the key is set and
 * the source is on. A toolkit that needs no sign-in and was added is in the group too, with the Added
 * mark and one Remove, which asks nothing of Composio.
 */
export function ComposioConnected(props: {
  layout: Layout;
  /** Opens an address in the browser; the system's by default. */
  open?: (url: string) => Promise<void>;
}) {
  const host = useHost();
  const c = colors();
  // What this host last showed: a group that is shown again starts from it, not from nothing.
  const before = remembered.get(host);
  const shown = signal<Connected[]>(before?.shown ?? []);
  /** Whether Re-authenticate and Disconnect show: a key is set and the source is not switched off. */
  const manage = signal(before?.manage ?? false);
  effect(() => {
    remembered.set(host, { shown: shown(), manage: manage() });
  });
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
  async function remove(slug: string) {
    error.set("");
    try {
      await host.call<PluginResults["composioRemove"]>(
        "plugins",
        "composioRemove",
        { slug },
      );
      shown.update((all) => all.filter((one) => one.slug !== slug));
      void plugins.read();
    } catch (cause) {
      error.set(cause instanceof Error ? cause.message : String(cause));
    }
  }
  async function read() {
    const answer = await host
      .call<PluginResults["composioConnected"]>(
        "plugins",
        "composioConnected",
        {},
      )
      .catch(() => undefined);
    // A host that cannot be asked leaves the toolkits as they were; one that answers "no" empties them.
    const connected =
      answer === undefined
        ? shown()
            .filter((one) => one.added !== true)
            .map((one) => one.slug)
        : answer.status === "ready" && Array.isArray(answer.slugs)
          ? answer.slugs
          : [];
    const addedAnswer = await host
      .call<PluginResults["composioAdded"]>("plugins", "composioAdded", {})
      .catch(() => undefined);
    const added = (
      Array.isArray(addedAnswer?.slugs) ? addedAnswer.slugs : []
    ).filter((slug) => !connected.includes(slug));
    if (connected.length + added.length === 0) {
      shown.set([]);
      return;
    }
    const status = await host
      .call<PluginResults["composioStatus"]>("plugins", "composioStatus", {})
      .catch(() => undefined);
    manage.set(status?.enabled === true);
    const kept = await host
      .call<PluginResults["composioToolkits"]>("plugins", "composioToolkits", {
        slugs: [...connected, ...added],
      })
      .catch(() => undefined);
    const known = new Map(
      (Array.isArray(kept?.toolkits) ? kept.toolkits : []).map((item) => [
        item.slug,
        item,
      ]),
    );
    shown.set(
      [...connected, ...added].map((slug) => ({
        slug,
        name: known.get(slug)?.name ?? slug,
        description: known.get(slug)?.description ?? "",
        ...(added.includes(slug) ? { added: true } : {}),
      })),
    );
  }
  effect(() => {
    untracked(() => void read());
  });
  const rows = () => props.layout !== "desktop";
  const actions = (item: Connected) => (
    <If
      when={item.added !== true}
      else={
        <View style={{ ...row, flexShrink: 0, gap: space[4] }}>
          <Button
            label={uiText("composioRemove")}
            tone="ghost"
            size={rows() ? control.lg : undefined}
            onPress={() => void remove(item.slug)}
          />
        </View>
      }
    >
      <If when={manage()}>
        <View style={{ ...row, flexShrink: 0, gap: space[4] }}>
          <Button
            label={uiText("composioReconnect")}
            tone="ghost"
            size={rows() ? control.lg : undefined}
            onPress={() => void reauth(item.slug)}
          />
          <Button
            label={uiText("composioDisconnect")}
            tone="ghost"
            size={rows() ? control.lg : undefined}
            onPress={() => disconnecting.set(item)}
          />
        </View>
      </If>
    </If>
  );
  const inset = () => (props.layout === "tablet" ? 14 : 16);
  /**
   * The last line of a card: the switch at the left, the buttons at the right. On a desktop card it is
   * the real card's bottom row (36 high, a line above it, 8 below the line, 4 between), 10 under the
   * description: the 24-high buttons sit in the 28 under the line, so they start 10 below it too; a row of the
   * phone and tablet layouts has no line. It never wraps: the buttons keep their width and the
   * switch's words give way (cut short, whole in the tooltip).
   */
  const footer = (item: Connected, divided = false) => (
    <View
      style={{
        ...row,
        alignItems: "center",
        justifyContent: "flex-end",
        gap: space[4],
        minHeight: divided ? 36 : space[24], // design-value: 36px divided action row, not on the space scale
        ...(divided
          ? {
              borderTopWidth: 1,
              borderColor: c().border,
              paddingTop: space[8],
              marginTop: 10, // design-value: 10px above the divided action row, not on the space scale
            }
          : {}),
      }}
    >
      <If when={viewOf(item.slug)}>
        {(view) => (
          <ComposioPluginSwitch view={view()} onChanged={plugins.read} />
        )}
      </If>
      {actions(item)}
    </View>
  );
  /**
   * The one status badge of a card, at the top right on the line of the name, in the colours of the
   * plugin cards' sign-in badge (`authStyle`): green "Connected" (signed_in); red "Unavailable"
   * (expired) when its session did not check out, with the reason in its tooltip. Nothing goes
   * under the name.
   */
  const mark = (item: Connected) => {
    const failed = () => viewOf(item.slug)?.state === "error";
    const look = () => authStyle(failed() ? "expired" : "signed_in");
    return (
      <View
        testID={
          failed()
            ? "composio-plugin-error"
            : item.added === true
              ? "composio-added"
              : "composio-connected"
        }
        tooltip={failed() ? hint(uiText("composioPluginError"), c) : undefined}
        style={{
          flexShrink: 0,
          paddingHorizontal: 6, // design-value: 6px badge padding, not on the space scale
          paddingVertical: 1,
          backgroundColor: c()[look().fill],
        }}
      >
        <Label variant="caption" tone={look().tone} lines={1}>
          {failed()
            ? uiText("composioUnavailable")
            : item.added === true
              ? uiText("composioAdded")
              : uiText("composioConnected")}
        </Label>
      </View>
    );
  };
  /** A card the user switched off for every agent is shown one step fainter. */
  const faint = (item: Connected) => ({
    opacity: viewOf(item.slug)?.enabled === false ? 0.55 : 1, // design-value: a switched-off card, fainter than muted and not disabled
  });
  return (
    <If when={shown().length}>
      <View
        testID="composio-connected-group"
        style={{ gap: rows() ? 0 : space[8] }}
      >
        <View
          style={{
            gap: space[2],
            paddingHorizontal: rows() ? inset() : 0,
            paddingTop: rows() ? space[16] : 0,
            paddingBottom: rows() ? 6 : 0, // design-value: 6px under the group title, not on the space scale
            borderBottomWidth: rows() ? 1 : 0,
            borderColor: c().border,
          }}
        >
          <Label variant="small">
            {uiText("composioGroup", { count: shown().length })}
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
                gap: space[12],
              }}
            >
              <Each of={shown()} key={(item) => item.slug}>
                {(item) => (
                  <View
                    testID="composio-connected-item"
                    accessibilityLabel={item().name}
                    style={{
                      ...faint(item()),
                      width: 267, // design-value: card width, as on the market's cards
                      padding: space[12],
                      backgroundColor: c().canvas,
                      borderWidth: 1,
                      borderColor: c().border,
                    }}
                  >
                    <View style={{ ...row, gap: space[8] }}>
                      <PluginLogo name={item().name} composio={item().slug} />
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <PluginName name={item().name} />
                      </View>
                      {mark(item())}
                    </View>
                    {/* Two lines high however short the text, 12 under the name row. */}
                    <Label
                      variant="small"
                      tone="muted"
                      lines={2}
                      style={{ height: 36, marginTop: space[12] }} // design-value: two lines of small text, 36px high
                    >
                      {item().description}
                    </Label>
                    {footer(item(), true)}
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
                      height: 60, // design-value: row height, as on the market's rows
                      gap: space[12],
                      paddingLeft: inset(),
                      paddingRight: space[12],
                    }}
                  >
                    <PluginLogo
                      name={item().name}
                      composio={item().slug}
                      size={avatar.lg}
                    />
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <PluginName name={item().name} />
                    </View>
                    {mark(item())}
                  </View>
                  <View
                    style={{
                      paddingLeft: inset(),
                      paddingRight: space[12],
                      paddingBottom: 10, // design-value: 10px under the footer, not on the space scale
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
