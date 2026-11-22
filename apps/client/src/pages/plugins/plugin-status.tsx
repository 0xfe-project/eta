import type { PluginView } from "@eta/client-contracts";
import { View } from "nsh";
import { colors, Empty, Icon, Label } from "../../components";
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
): { text: "serverSignedIn" | "serverNeedsLogin" | "serverExpired" | "serverNeedsSetup"; tone: "green" | "warningInk" | "red" } =>
  state === "signed_in"
    ? { text: "serverSignedIn", tone: "green" }
    : state === "expired"
      ? { text: "serverExpired", tone: "red" }
      : state === "needs_login"
        ? { text: "serverNeedsLogin", tone: "warningInk" }
        : { text: "serverNeedsSetup", tone: "warningInk" };

/** The login a card shows, from its servers' states: only with evidence, never for headers-only servers. */
export function cardLogin(item: PluginView): "needs_login" | "signed_in" | "expired" | undefined {
  const oauth = item.servers.filter(
    (server) => server.login !== undefined && server.login !== "none" && !(server.headers?.length ?? 0),
  );
  if (!oauth.length) return undefined;
  if (oauth.some((server) => server.login === "expired")) return "expired";
  return oauth.some((server) => server.login === "needs_login") ? "needs_login" : "signed_in";
}

export function Status(props: { item: PluginView; phone?: boolean }) {
  const c = colors();
  const missing = () => props.item.state === "needs_config";
  return (
    <Label
      variant="caption"
      lines={1}
      tone={missing() ? "warningInk" : "muted"}
      style={{
        alignSelf: props.phone ? "flex-start" : "center",
        paddingHorizontal: missing() ? 6 : 0,
        paddingVertical: 1,
        borderWidth: missing() ? 1 : 0,
        borderColor: c().warning,
      }}
    >
      {!props.item.enabled
        ? uiText("pluginOffForAll")
        : missing()
          ? uiText("needsConfiguring")
          : uiText("canBeEnabled")}
    </Label>
  );
}

/** No plugins: the design's empty state, under the intro. */
export function NoPlugins(props: { width: number }) {
  return (
    <Empty
      title={uiText("noPluginsYet")}
      description={uiText("noPluginsHint")}
      icon="plugins"
      iconSize={32}
      descriptionWidth={props.width}
      style={{
        flex: undefined,
        justifyContent: "flex-start",
        paddingVertical: 40,
      }}
    />
  );
}
