import type { Layout } from "../../components";
import type { HostAddress } from "../../services/host";
import type { ConnectionFailure } from "./diagnostics";
import { View } from "nsh";
import { Button, colors, grow, Header, Label, row } from "../../components";
import { uiText } from "../../i18n";

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
  },
) {
  const c = colors();
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
        title={props.message[0]}
        layout={props.layout}
        inset={16}
        dialog
      />
      <View style={{ padding: 16, gap: 12 }}>
        <If
          when={
            (props.problem === "address" ||
              props.problem === "not-eta" ||
              props.problem === "lost") &&
            props.address
          }
        >
          <Label>{props.address?.origin}</Label>
        </If>
        <Label size={14} line={20} tone="mutedInk">
          {props.message[1]}
        </Label>
        <If when={props.problem === "local" && props.error}>
          <Label size={12} line={16} tone="red">
            {props.error}
          </Label>
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
        <Label size={24} line={32}>
          {uiText("lostTheConnectionToTheHost")}
        </Label>
        <Label tone="muted">
          {props.address?.origin ? new URL(props.address!.origin).host : ""}
          {props.lastOnline
            ? uiText("lastOnline", {
                toLocaleTimeString: new Date(
                  props.lastOnline!,
                ).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                }),
              })
            : ""}
        </Label>
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
