import type { AgentRuntimeInfo } from "@eta/client-contracts";
import { View } from "nsh";
import { Button, Fonts, Label, monoFontFamily, row } from "../../../components";
import { control, space } from "../../../components/tokens";
import { uiText } from "../../../i18n";
import { WarningLine } from "../section";
import { LOGIN_COMMANDS } from "./status";

/** A runtime's own words, as it said them: monospace, wrapped. */
export function RuntimeWords(props: { children: string }) {
  const fonts = Fonts();
  return (
    <Label
      variant="small"
      tone="muted"
      style={{ fontFamily: monoFontFamily(fonts()) }}
    >
      {props.children}
    </Label>
  );
}

/**
 * What goes under the Runtime field: the chosen runtime's own trouble, in one line — its sign-in
 * command when it is signed out, why it cannot be picked when it is missing or failing — and
 * "Retry", which asks the machine again past the host's cache. A runtime that answers says
 * nothing here, and what the other runtimes on the machine are doing is on their own page, not in
 * this agent's editor.
 */
export function RuntimeHints(props: {
  /** Undefined while the machine answers; null when it could not be asked. */
  runtimes: AgentRuntimeInfo[] | null | undefined;
  chosen: AgentRuntimeInfo | undefined;
  probing: boolean;
  error: string | undefined;
  onRetry: () => void;
  onRuntimes?: (() => void) | undefined;
}) {
  const signIn = () =>
    props.chosen?.status === "unauthenticated"
      ? LOGIN_COMMANDS[props.chosen.id]
      : undefined;
  const reason = () => {
    if (props.runtimes === null) return uiText("runtimeUnreachable");
    const chosen = props.chosen;
    if (chosen === undefined) return undefined;
    if (chosen.status === "missing")
      return uiText("runtimeMissingHint", { runtime: chosen.label });
    if (chosen.status === "error")
      return uiText("runtimeErrorHint", { runtime: chosen.label });
    return undefined;
  };
  /** The runtime's own words for a failure: the real reason, kept in its monospace words. */
  const words = () =>
    props.chosen?.status === "error" ? props.chosen.detail : undefined;
  const shown = () =>
    props.runtimes === null || !!signIn() || !!reason() || !!props.error;
  return (
    <If when={shown()}>
      <View style={{ alignSelf: "stretch", gap: space[4] }}>
        <If when={signIn()}>
          {(command) => (
            <View style={{ gap: space[2] }}>
              <WarningLine
                outline
                text={uiText("runtimeSignInHint", {
                  runtime: props.chosen!.label,
                  command: command(),
                })}
              />
              <If when={props.onRuntimes}>
                <View
                  role="link"
                  accessibilityLabel={uiText("runtimeSeeInSettings")}
                  onPress={() => props.onRuntimes?.()}
                  style={{ cursor: "pointer", paddingLeft: space[20] }}
                >
                  <Label
                    variant="small"
                    tone="mutedInk"
                    style={{ textDecorationLine: "underline" }}
                  >
                    {uiText("runtimeSeeInSettings")}
                  </Label>
                </View>
              </If>
            </View>
          )}
        </If>
        <View style={{ ...row, gap: space[8], minHeight: space[20] }}>
          <If when={reason()}>
            {(text) => (
              <Label variant="small" tone="mutedInk" style={{ flex: 1 }}>
                {text()}
              </Label>
            )}
          </If>
          <If when={!reason()}>
            <View style={{ flex: 1 }} />
          </If>
          <Button
            label={uiText("runtimeRetry")}
            tone="ghost"
            size={control.sm}
            labelTone="mutedInk"
            busy={props.probing}
            style={{ paddingHorizontal: 0 }}
            onPress={props.onRetry}
          />
        </View>
        <If when={words()}>
          {(detail) => <RuntimeWords>{detail()}</RuntimeWords>}
        </If>
        <If when={props.error}>
          {(error) => (
            <Label variant="small" tone="mutedInk">
              {error()}
            </Label>
          )}
        </If>
      </View>
    </If>
  );
}
