import type { JSX } from "nsh";
import { View } from "nsh";
import {
  Button,
  colors,
  grow,
  Label,
  row,
  SmoothScroll,
} from "../../components";
import { space } from "../../components/tokens";
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
    <SmoothScroll style={grow} contentStyle={{ flexGrow: 1 }}>
      <PhoneHero />
      <View
        style={{
          flexGrow: 1,
          minHeight: 190,
          justifyContent: "flex-end",
          paddingHorizontal: space[16],
          paddingBottom: space[24],
          paddingTop: space[16],
          gap: space[12],
        }}
      >
        <If
          when={props.remoteFailure}
          else={
            <>
              <Label variant="display" style={{ letterSpacing: -1.28 }}>
                ETA
              </Label>
              <ConnectionIntro phone />
            </>
          }
        >
          <Label variant="title">{uiText("cantReachThisHost")}</Label>
          <Label tone="mutedInk">{props.remoteReason}</Label>
        </If>
      </View>
      <View>
        {props.children}
        <ConnectionMessage error={props.error} />
        <View
          style={{
            paddingHorizontal: space[16],
            paddingTop: space[16],
            paddingBottom: 34,
            gap: space[8],
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
              labelVariant="body"
              dimDisabled={props.connecting}
              disabled={props.busy || !props.address.trim()}
              onPress={props.onConnect}
            />
            <If when={props.scanFailure && !props.remoteFailure}>
              <View
                role="alert"
                onPress={props.onDismissScan}
                style={{
                  ...row,
                  position: "absolute",
                  left: 0,
                  right: 0,
                  bottom: 0,
                  minHeight: 52,
                  paddingVertical: 10,
                  paddingHorizontal: space[12],
                  backgroundColor: c().button,
                }}
              >
                <Label tone="buttonInk" style={{ flex: 1, minWidth: 0 }}>
                  {props.scanNotice}
                </Label>
              </View>
            </If>
          </View>
          <If when={!props.remoteFailure}>
            <Button
              label={props.scanLabel}
              size={52}
              labelVariant="body"
              disabled={props.busy}
              onPress={props.onScan}
            />
          </If>
        </View>
      </View>
    </SmoothScroll>
  );
}
