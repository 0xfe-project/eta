import type { Layout } from "../../components";
import type { HostAddress } from "../../services/host";
import type { ConnectionFailure } from "./diagnostics";
import { View } from "nsh";
import {
  Button,
  colors,
  Fonts,
  grow,
  Header,
  Label,
  monoFontFamily,
  row,
} from "../../components";
import { control, space } from "../../components/tokens";
import { uiText } from "../../i18n";
import { cardWidth } from "./visuals";

function Mono(props: { children?: string }) {
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

function lastSeen(address?: HostAddress, lastOnline?: number | null) {
  const host = address?.origin ? new URL(address.origin).host : "";
  return lastOnline
    ? host +
        uiText("lastOnline", {
          toLocaleTimeString: new Date(lastOnline).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            hourCycle: "h23",
          }),
        })
    : host;
}

interface RetryProps {
  address?: HostAddress;
  onRetry: () => void;
  onChange: () => void;
}

export function ConnectionError(
  props: RetryProps & {
    message: readonly string[];
    problem?: ConnectionFailure;
    error: string;
    layout: Layout;
    tablet: boolean;
    lastOnline: number | null;
  },
) {
  const c = colors();
  const lost = () => props.tablet && props.problem === "lost";
  return (
    <View
      style={{
        width: "100%",
        maxWidth: cardWidth,
        borderWidth: 1,
        borderColor: c().strong,
        backgroundColor: c().canvas,
      }}
    >
      <Header
        title={lost() ? uiText("lostTheConnectionToTheHost") : props.message[0]}
        layout={props.layout}
        inset={space[16]}
        dialog
      />
      <View style={{ padding: space[16], gap: lost() ? space[8] : space[12] }}>
        <If
          when={lost()}
          else={
            <If
              when={
                (props.problem === "address" ||
                  props.problem === "not-eta" ||
                  props.problem === "lost") &&
                props.address
              }
            >
              <Mono>{props.address?.origin}</Mono>
            </If>
          }
        >
          <Label tone="muted">
            {lastSeen(props.address, props.lastOnline)}
          </Label>
        </If>
        <Label tone="mutedInk">
          {lost() ? uiText("agentsKeepRunningOnTheHost") : props.message[1]}
        </Label>
        <If when={props.problem === "local" && props.error}>
          <Mono>{props.error}</Mono>
        </If>
      </View>
      <View
        style={{
          ...row,
          justifyContent: "flex-end",
          borderTopWidth: 1,
          borderColor: c().border,
          gap: space[8],
          padding: space[12],
          paddingHorizontal: space[16],
        }}
      >
        <If
          when={lost()}
          else={
            <>
              <Button
                label={uiText("retry")}
                tone="primary"
                size={control.sm}
                style={{ paddingHorizontal: space[12] }}
                onPress={props.onRetry}
              />
              <Button
                label={uiText("changeConnection")}
                size={control.sm}
                style={{ paddingHorizontal: space[12] }}
                onPress={props.onChange}
              />
            </>
          }
        >
          <Button
            label={uiText("useAnotherHost")}
            size={control.touch}
            labelVariant="body"
            style={{ paddingHorizontal: space[24] }}
            onPress={props.onChange}
          />
          <Button
            label={uiText("retry")}
            tone="primary"
            size={control.touch}
            labelVariant="body"
            style={{ paddingHorizontal: space[24] }}
            onPress={props.onRetry}
          />
        </If>
      </View>
    </View>
  );
}

export function LostPhoneConnection(
  props: RetryProps & { lastOnline: number | null },
) {
  return (
    <View style={{ ...grow, width: "100%" }}>
      <View
        style={{
          ...grow,
          justifyContent: "flex-end",
          gap: space[8],
          paddingHorizontal: space[16],
          paddingBottom: space[32],
        }}
      >
        <Label tracking="tight" variant="display">
          ETA
        </Label>
        <Label tracking="tight" variant="title">
          {uiText("lostTheConnectionToTheHost")}
        </Label>
        <Label tone="muted">{lastSeen(props.address, props.lastOnline)}</Label>
        <Label tone="muted">{uiText("agentsKeepRunningOnTheHost")}</Label>
      </View>
      <View
        style={{
          paddingHorizontal: space[16],
          paddingTop: space[8],
          paddingBottom: space[32],
          gap: space[8],
        }}
      >
        <Button
          label={uiText("retry")}
          tone="primary"
          size={control.touch}
          labelVariant="body"
          onPress={props.onRetry}
        />
        <Button
          label={uiText("useAnotherHost")}
          size={control.touch}
          labelVariant="body"
          onPress={props.onChange}
        />
      </View>
    </View>
  );
}
