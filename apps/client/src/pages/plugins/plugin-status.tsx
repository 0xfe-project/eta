import type { PluginView } from "@eta/client-contracts";
import { View } from "nsh";
import { colors, Icon, Label } from "../../components";
import { EmptyState } from "../../components/empty-state";
import { ListSkeleton } from "../../components/loading-skeleton";
import { space } from "../../components/tokens";
import { uiText } from "../../i18n";
import { useLoadState } from "../../services/load-status";
import { Badge } from "../../ui";

export function PluginGlyph(props: { size: number }) {
  const c = colors();
  return (
    <View
      style={{
        width: props.size,
        height: props.size,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: c().selected,
        borderWidth: 1,
        borderColor: c().border,
        flexShrink: 0,
      }}
    >
      <Icon
        name="plugins"
        size={Math.round(props.size * 0.52)}
        tone="mutedInk"
      />
    </View>
  );
}

export type AuthState = "signed_in" | "needs_login" | "expired" | "needs_setup";

/**
 * The one map from an auth state to its label and colour, used by the card badge and the panel
 * label so they cannot differ. Green: signed in. Amber (warning): nothing wrong yet, a step is
 * missing (sign in, fill a field). Red: a failure with evidence, a stored sign-in the server refused.
 * The text always says it, so colour is never the only signal.
 */
export const authStyle = (
  state: AuthState,
): {
  text:
    | "serverSignedIn"
    | "serverNeedsLogin"
    | "serverExpired"
    | "serverNeedsSetup";
  tone: "green" | "warningInk" | "red";
  /** The quiet badge: the state colour's fill token as its background (as the task status chips). */
  fill: "greenFill" | "warningFill" | "redFill";
} =>
  state === "signed_in"
    ? {
        text: "serverSignedIn",
        tone: "green",
        fill: "greenFill",
      }
    : state === "expired"
      ? { text: "serverExpired", tone: "red", fill: "redFill" }
      : state === "needs_login"
        ? {
            text: "serverNeedsLogin",
            tone: "warningInk",
            fill: "warningFill",
          }
        : {
            text: "serverNeedsSetup",
            tone: "warningInk",
            fill: "warningFill",
          };

/**
 * The login a card shows, from its servers' states: only with evidence, never for headers-only
 * servers. A Cursor server with no Cursor sign-in is the one local fact that needs no test (the
 * same condition the server's own badge uses).
 */
export function cardLogin(
  item: PluginView,
): "needs_login" | "signed_in" | "expired" | undefined {
  if (
    item.servers.some(
      (server) =>
        server.cursorServer === true &&
        server.cursorSignedIn !== true &&
        server.login !== "signed_in",
    )
  )
    return "needs_login";
  const oauth = item.servers.filter(
    (server) =>
      server.login !== undefined &&
      server.login !== "none" &&
      !(server.headers?.length ?? 0),
  );
  if (!oauth.length) return undefined;
  if (oauth.some((server) => server.login === "expired")) return "expired";
  return oauth.some((server) => server.login === "needs_login")
    ? "needs_login"
    : "signed_in";
}

/**
 * Off for all agents, or needs configuring. A ready plugin shows nothing: "can be enabled" says no
 * more than the absence of the other two. `hideOff` leaves out "off for all agents", for a card
 * whose own switch says it right below.
 */
export function Status(props: {
  item: PluginView;
  phone?: boolean;
  hideOff?: boolean;
}) {
  const missing = () => props.item.state === "needs_config";
  const off = () => !props.item.enabled && props.hideOff !== true;
  return (
    <If when={off() || missing()}>
      <If
        when={missing() && !off()}
        else={
          <Label
            variant="caption"
            lines={1}
            tone="muted"
            style={{ alignSelf: props.phone ? "flex-start" : "center" }}
          >
            {uiText("pluginOffForAll")}
          </Label>
        }
      >
        <Badge
          label={uiText("needsConfiguring")}
          tone="warning"
          variant="outline"
          size="caption"
          style={{ alignSelf: props.phone ? "flex-start" : "center" }}
        />
      </If>
    </If>
  );
}

/** No plugins, under the intro: or not loaded yet, or the list did not load. */
export function NoPlugins(props: { onAdd: () => void; onMarket?: () => void }) {
  const load = useLoadState({ targets: () => ["plugins"] });
  return (
    <EmptyState
      size="page"
      status={load.shown()}
      loading={<ListSkeleton label={uiText("loadingPlugins")} />}
      error={{
        title: uiText("pluginsDidNotLoad"),
        description: load.why(),
        retry: load.retry,
        retrying: load.retrying(),
      }}
      empty={{
        art: "plugins",
        title: uiText("noPluginsYet"),
        description: uiText("noPluginsHint"),
        actions: [
          { label: uiText("addFromGit"), icon: "plus", onPress: props.onAdd },
          ...(props.onMarket
            ? [{ label: uiText("browseMarket"), onPress: props.onMarket }]
            : []),
        ],
      }}
      style={{ paddingHorizontal: 0, paddingVertical: space[24] }}
    />
  );
}
