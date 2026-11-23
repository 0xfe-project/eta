import type { MarketCatalog, PluginResults } from "@eta/client-contracts";
import type { Layout } from "../../components";
import { effect, signal, untracked, View } from "nsh";
import { colors, grow, Label, row, textFaces } from "../../components";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";
import { PluginLogo } from "./plugin-logo";
import { PluginName } from "./plugin-name";

interface Connected {
  slug: string;
  name: string;
  description: string;
}

/**
 * The Composio toolkits the user connected on Composio, under the installed plugins. A list of what
 * is linked there, nothing more: eta's agents cannot use it yet, and the text says so. The names and
 * pictures come from the list the host already keeps (never asked for from the network here); a
 * toolkit that is not in it is shown by its slug. When Composio cannot be asked (no key, a refused
 * key, no answer) the group is not there, and nothing says why.
 */
export function ComposioConnected(props: { layout: Layout }) {
  const host = useHost();
  const c = colors();
  const type = textFaces();
  const shown = signal<Connected[]>([]);
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
    const kept = await host
      .call<MarketCatalog>("plugins", "marketCatalog", { mode: "cached" })
      .catch(() => undefined);
    const known = new Map(
      (kept?.sources ?? [])
        .flatMap((item) => item.toolkits ?? [])
        .map((item) => [item.slug, item]),
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
  const inset = () => (props.layout === "tablet" ? 14 : 16);
  /** The same mark as an installed market card has, at the right of the last line. */
  const mark = () => (
    <View testID="composio-connected" style={{ flexShrink: 1, minWidth: 0 }}>
      <Label variant="small" lines={1}>
        {uiText("composioConnected")}
      </Label>
    </View>
  );
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
        </View>
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
                    </View>
                    <Label variant="small" tone="muted" lines={2}>
                      {item().description}
                    </Label>
                    <View
                      style={{ ...row, gap: 8, minHeight: type("small").line }}
                    >
                      <View style={grow}>
                        <Label variant="caption" tone="muted" lines={1}>
                          {uiText("marketFrom", { name: "Composio" })}
                        </Label>
                      </View>
                      {mark()}
                    </View>
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
                    ...row,
                    height: 60,
                    gap: 12,
                    paddingLeft: inset(),
                    paddingRight: 12,
                    borderBottomWidth: 1,
                    borderColor: c().border,
                    backgroundColor: c().canvas,
                  }}
                >
                  <PluginLogo
                    name={item().name}
                    composio={item().slug}
                    size={32}
                  />
                  <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                    <PluginName name={item().name} />
                    <Label variant="caption" tone="muted" lines={1}>
                      {uiText("marketFrom", { name: "Composio" })}
                    </Label>
                  </View>
                  {mark()}
                </View>
              )}
            </Each>
          </View>
        </If>
      </View>
    </If>
  );
}
