import { View } from "nsh";
import { Button, colors, Label, row } from "../../components";
import { StatusDot } from "../../components/status-dot";
import { control, space } from "../../components/tokens";
import { uiText } from "../../i18n";
export function ReconnectingBanner(props: {
  phone: boolean;
  onConnect: () => void;
}) {
  const c = colors();
  return (
    <View
      style={{
        ...row,
        paddingVertical: props.phone ? space[12] : space[8],
        paddingHorizontal: space[16],
        gap: space[8],
        backgroundColor: c().selected,
        borderBottomWidth: 1,
        borderColor: c().border,
        flexShrink: 0,
      }}
    >
      <If when={!props.phone}>
        <StatusDot color={c().warning} />
      </If>
      <Label variant="small" style={{ flex: 1 }}>
        {props.phone
          ? uiText("connectionLostReconnectingWhatYouSee")
          : uiText("connectionLostReconnecting")}
      </Label>
      <If when={!props.phone}>
        {/* Not in the design (apps/web had no button); kept so the host
            can be changed without waiting for the Lost dialog. Drawn over
            the 16px text line so the strip keeps the design's height. */}
        <Button
          label={uiText("changeHost")}
          size={control.sm}
          style={{ marginVertical: -space[4] }}
          onPress={props.onConnect}
        />
      </If>
    </View>
  );
}
