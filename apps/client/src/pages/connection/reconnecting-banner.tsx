import { View } from "nsh";
import { Button, colors, Label, row } from "../../components";
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
        paddingVertical: props.phone ? 10 : 8,
        paddingHorizontal: 16,
        gap: 8,
        backgroundColor: c().selected,
        borderBottomWidth: 1,
        borderColor: c().border,
        flexShrink: 0,
      }}
    >
      <If when={!props.phone}>
        <View
          style={{
            width: 6,
            height: 6,
            backgroundColor: c().warning,
            flexShrink: 0,
          }}
        />
      </If>
      <Label variant="small" style={{ flex: 1 }}>
        {props.phone
          ? uiText("connectionLostReconnectingWhatYouSee")
          : uiText("connectionLostReconnecting")}
      </Label>
      <If when={!props.phone}>
        {/* Not in the design (apps/web had no button); kept so the host
            can be changed without waiting for the Lost dialog. Sized to
            the 16px text line so the strip keeps the design's height. */}
        <Button
          label={uiText("changeHost")}
          size={20}
          style={{ marginVertical: -2 }}
          onPress={props.onConnect}
        />
      </If>
    </View>
  );
}
