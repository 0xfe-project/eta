import type { AgentRuntimeInfo } from "@eta/client-contracts";
import { View } from "nsh";
import { Button, Fonts, Label, monoFontFamily, row } from "../../../components";
import { control, space, weight } from "../../../components/tokens";
import { uiText } from "../../../i18n";
import { Disclosure } from "../../../ui";
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
 * What goes under the Runtime field: the chosen runtime's sign-in command when it is signed out,
 * then "Details" (each runtime that cannot be picked, in its own words) and "Retry", which asks
 * the machine again past the host's cache.
 */
export function RuntimeHints(props: {
  /** Undefined while the machine answers; null when it could not be asked. */
  runtimes: AgentRuntimeInfo[] | null | undefined;
  explained: AgentRuntimeInfo[];
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
  const shown = () =>
    props.runtimes === null || props.explained.length > 0 || !!signIn();
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
        <If when={props.runtimes === null}>
          <Label variant="small" tone="muted">
            {uiText("runtimeUnreachable")}
          </Label>
        </If>
        <Disclosure.Root>
          <View style={{ ...row, gap: space[8], minHeight: space[20] }}>
            <If when={props.explained.length > 0}>
              <Disclosure.Trigger label={uiText("runtimeDetails")} />
            </If>
            <View style={{ flex: 1 }} />
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
          <If when={props.explained.length > 0}>
            <Disclosure.Content
              style={{ gap: space[4], paddingLeft: space[16] }}
            >
              <Each of={props.explained} key={(item) => item.id}>
                {(item) => (
                  <View style={{ gap: 1 }}>
                    <Label
                      variant="small"
                      weight={weight.regular}
                      tone="mutedInk"
                    >
                      {item().label}
                    </Label>
                    <RuntimeWords>{item().detail ?? ""}</RuntimeWords>
                  </View>
                )}
              </Each>
            </Disclosure.Content>
          </If>
        </Disclosure.Root>
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
