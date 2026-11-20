import { View } from "nsh";
import { colors, Field, Label, row } from "../../components";
import { uiText } from "../../i18n";

export function HostFields(props: {
  plain?: boolean;
  tablet?: boolean;
  address: string;
  token: string;
  onAddress: (value: string) => void;
  onToken: (value: string) => void;
  onSubmit: () => void;
}) {
  const c = colors();
  const fieldStyle = () =>
    props.plain
      ? {
          flex: 1,
          height: 54,
          borderWidth: 0,
          paddingHorizontal: 0,
          fontSize: 16,
        }
      : {
          flex: 1,
          height: props.tablet ? 44 : 32,
          fontSize: props.tablet ? 16 : 14,
        };
  const line = () =>
    props.plain
      ? {
          ...row,
          height: 56,
          paddingHorizontal: 16,
          gap: 16,
          borderBottomWidth: 1,
          borderColor: c().border,
        }
      : { ...row, gap: 8 };
  return (
    <View
      style={{
        gap: props.plain ? 0 : 8,
        borderTopWidth: props.plain ? 1 : 0,
        borderColor: c().border,
      }}
    >
      <View style={line()}>
        <Label
          size={props.plain ? 11 : 14}
          tone="muted"
          style={{ width: props.plain ? 44 : 64 }}
        >
          {uiText("address")}
        </Label>
        <Field
          label={uiText("hostAddress")}
          placeholder={uiText("hostAddressOrEtaLink")}
          value={props.address}
          onChange={props.onAddress}
          onSubmit={props.onSubmit}
          style={fieldStyle()}
        />
      </View>
      <View style={line()}>
        <Label
          size={props.plain ? 11 : 14}
          tone="muted"
          style={{ width: props.plain ? 44 : 64 }}
        >
          {uiText("token")}
        </Label>
        <Field
          label={uiText("hostToken")}
          placeholder={uiText("accessToken")}
          value={props.token}
          masked
          onChange={props.onToken}
          onSubmit={props.onSubmit}
          style={fieldStyle()}
        />
      </View>
    </View>
  );
}
