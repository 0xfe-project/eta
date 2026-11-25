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
import { control, space } from "../../components/tokens";
import { uiText } from "../../i18n";
import { ConnectionIntro, ConnectionMessage, PhoneHero } from "./visuals";

/** The least room the intro over the form takes. */
const introHeight = 192;

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
          minHeight: introHeight,
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
              <Label tracking="tight" variant="display">
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
            paddingBottom: space[32],
            gap: space[8],
          }}
        >
          <View style={{ position: "relative" }}>
            <Button
              label={props.remoteFailure ? uiText("retry") : uiText("connect")}
              tone="primary"
              size={control.touch}
              labelVariant="body"
              disabled={
                !props.address.trim() || (props.busy && !props.connecting)
              }
              busy={props.connecting}
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
                  minHeight: control.touch,
                  paddingVertical: space[12],
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
              size={control.touch}
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
