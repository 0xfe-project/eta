import type { Layout } from "../../components";
import type { HostAddress } from "../../services/host";
import type { ConnectionFailure } from "./diagnostics";
import { View } from "nsh";
import {
  Button,
  colors,
  fontFamily,
  Fonts,
  grow,
  Header,
  Label,
  row,
} from "../../components";
import { uiText } from "../../i18n";

function Mono(props: { children?: string }) {
  const fonts = Fonts();
  return (
    <Label
      size={12}
      line={16}
      tone="muted"
      style={{ fontFamily: fontFamily(fonts().mono, "monospace") }}
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
        maxWidth: 480,
        borderWidth: 1,
        borderColor: c().strong,
        backgroundColor: c().canvas,
      }}
    >
      <Header
        title={lost() ? uiText("lostTheConnectionToTheHost") : props.message[0]}
        layout={props.layout}
        inset={16}
        titleLine={props.layout === "phone" ? undefined : 24}
        dialog
      />
      <View style={{ padding: 16, gap: lost() ? 8 : 12 }}>
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
          <Label size={14} line={20} tone="muted">
            {lastSeen(props.address, props.lastOnline)}
          </Label>
        </If>
        <Label size={14} line={20} tone="mutedInk">
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
          gap: 8,
          padding: 12,
          paddingHorizontal: 16,
        }}
      >
        <If
          when={lost()}
          else={
            <>
              <Button
                label={uiText("retry")}
                tone="primary"
                size={24}
                style={{ paddingHorizontal: 12 }}
                onPress={props.onRetry}
              />
              <Button
                label={uiText("changeConnection")}
                size={24}
                style={{ paddingHorizontal: 12 }}
                onPress={props.onChange}
              />
            </>
          }
        >
          <Button
            label={uiText("useAnotherHost")}
            size={44}
            labelSize={14}
            style={{ paddingHorizontal: 24 }}
            onPress={props.onChange}
          />
          <Button
            label={uiText("retry")}
            tone="primary"
            size={44}
            labelSize={14}
            style={{ paddingHorizontal: 24 }}
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
          gap: 8,
          paddingHorizontal: 16,
          paddingBottom: 32,
        }}
      >
        <Label size={64} line={64} style={{ letterSpacing: -1.28 }}>
          ETA
        </Label>
        <Label size={24} line={32} style={{ letterSpacing: -0.24 }}>
          {uiText("lostTheConnectionToTheHost")}
        </Label>
        <Label tone="muted">{lastSeen(props.address, props.lastOnline)}</Label>
        <Label tone="muted">{uiText("agentsKeepRunningOnTheHost")}</Label>
      </View>
      <View
        style={{
          paddingHorizontal: 16,
          paddingTop: 8,
          paddingBottom: 34,
          gap: 8,
        }}
      >
        <Button
          label={uiText("retry")}
          tone="primary"
          size={52}
          labelSize={14}
          onPress={props.onRetry}
        />
        <Button
          label={uiText("useAnotherHost")}
          size={52}
          labelSize={14}
          onPress={props.onChange}
        />
      </View>
    </View>
  );
}
