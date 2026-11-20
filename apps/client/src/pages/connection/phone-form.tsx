import type { JSX } from "nsh";
import { Scroll, View } from "nsh";
import { Button, colors, fill, grow, Label, row } from "../../components";
import { uiText } from "../../i18n";
import { ConnectionIntro, ConnectionMessage, PhoneHero } from "./visuals";

export function PhoneConnectionForm(props: {
  children?: JSX.Element;
  address: string;
  remoteFailure: boolean;
  remoteReason: string;
  connecting: boolean;
  busy: boolean;
  scanFailure: boolean;
  scanNotice: string;
  scanLabel: string;
  error: string;
  onConnect: () => void;
  onDismissScan: () => void;
  onScan: () => void;
}) {
  const c = colors();
  return (
    <Scroll style={grow} contentStyle={{ flexGrow: 1 }}>
      <PhoneHero />
      <View
        style={{
          flexGrow: 1,
          minHeight: 190,
          justifyContent: "flex-end",
          paddingHorizontal: 16,
          paddingBottom: 24,
          paddingTop: 16,
          gap: 12,
        }}
      >
        <If
          when={props.remoteFailure}
          else={
            <>
              <Label size={64} line={64} style={{ letterSpacing: -1.28 }}>
                ETA
              </Label>
              <ConnectionIntro phone />
            </>
          }
        >
          <Label size={24} line={31}>
            {uiText("cantReachThisHost")}
          </Label>
          <Label size={14} tone="mutedInk">
            {props.remoteReason}
          </Label>
        </If>
      </View>
      <View>
        {props.children}
        <ConnectionMessage error={props.error} />
        <View
          style={{
            paddingHorizontal: 16,
            paddingTop: 16,
            paddingBottom: 34,
            gap: 8,
          }}
        >
          <View style={{ position: "relative" }}>
            <Button
              label={
                props.connecting
                  ? uiText("connecting")
                  : props.remoteFailure
                    ? uiText("retry")
                    : uiText("connect")
              }
              tone="primary"
              size={52}
              labelSize={14}
              dimDisabled={props.connecting}
              disabled={props.busy || !props.address.trim()}
              onPress={props.onConnect}
            />
            <If when={props.scanFailure && !props.remoteFailure}>
              <View
                role="alert"
                onPress={props.onDismissScan}
                style={{
                  ...fill,
                  ...row,
                  paddingHorizontal: 12,
                  backgroundColor: c().button,
                }}
              >
                <Label
                  size={14}
                  tone="buttonInk"
                  style={{ flex: 1, minWidth: 0 }}
                >
                  {props.scanNotice}
                </Label>
              </View>
            </If>
          </View>
          <If when={!props.remoteFailure}>
            <Button
              label={props.scanLabel}
              size={52}
              labelSize={14}
              disabled={props.busy}
              onPress={props.onScan}
            />
          </If>
        </View>
      </View>
    </Scroll>
  );
}
