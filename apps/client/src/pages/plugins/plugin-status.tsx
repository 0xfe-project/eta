import type { PluginView } from "@eta/client-contracts";
import { View } from "nsh";
import { colors, Empty, Icon, Label } from "../../components";
import { icon, space } from "../../components/tokens";
import { uiText } from "../../i18n";

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
  const c = colors();
  const missing = () => props.item.state === "needs_config";
  const off = () => !props.item.enabled && props.hideOff !== true;
  return (
    <If when={off() || missing()}>
      <Label
        variant="caption"
        lines={1}
        tone={missing() ? "warningInk" : "muted"}
        style={{
          alignSelf: props.phone ? "flex-start" : "center",
          paddingHorizontal: missing() ? space[8] : 0,
          paddingVertical: 1,
          borderWidth: missing() ? 1 : 0,
          borderColor: c().warning,
        }}
      >
        {off() ? uiText("pluginOffForAll") : uiText("needsConfiguring")}
      </Label>
    </If>
  );
}

/** No plugins: the design's empty state, under the intro. */
export function NoPlugins() {
  return (
    <Empty
      title={uiText("noPluginsYet")}
      description={uiText("noPluginsHint")}
      icon="plugins"
      iconSize={icon.xl}
      style={{
        flex: undefined,
        justifyContent: "flex-start",
        paddingVertical: space[40],
      }}
    />
  );
}
