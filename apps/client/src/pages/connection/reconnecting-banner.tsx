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
        padding: 8,
        paddingHorizontal: 14,
        gap: 8,
        backgroundColor: props.phone ? c().surface : c().amberFill,
        borderBottomWidth: props.phone ? 1 : 0,
        borderColor: c().border,
        flexShrink: 0,
      }}
    >
      <Label
        size={12}
        tone={props.phone ? "muted" : "amber"}
        style={{ flex: 1 }}
      >
        {props.phone
          ? uiText("connectionLostReconnectingWhatYouSee")
          : uiText("connectionLostReconnecting")}
      </Label>
      <If when={!props.phone}>
        <Button label={uiText("changeHost")} onPress={props.onConnect} />
      </If>
    </View>
  );
}
