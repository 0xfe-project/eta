import { View } from "nsh";
import { colors, Field, Label, row, textFaces } from "../../components";
import { border, control, space, tracked } from "../../components/tokens";
import { uiText } from "../../i18n";

/** A row of the plain (phone) form; its field sits inside the row's bottom line. */
const plainRowHeight = 56;

export function HostFields(props: {
  plain?: boolean;
  tablet?: boolean;
  tokenWrong?: boolean;
  address: string;
  token: string;
  onAddress: (value: string) => void;
  onToken: (value: string) => void;
  onSubmit: () => void;
}) {
  const c = colors();
  const type = textFaces();
  const fieldStyle = () =>
    props.plain
      ? {
          flex: 1,
          height: plainRowHeight - 2 * border.hair,
          borderWidth: 0,
          paddingHorizontal: 0,
          fontSize: type("subtitle").size,
        }
      : props.tablet
        ? {
            flex: 1,
            height: control.touch,
            paddingHorizontal: space[12],
          }
        : { flex: 1, height: space[32] };
  const line = () =>
    props.plain
      ? {
          ...row,
          height: plainRowHeight,
          paddingHorizontal: space[16],
          gap: space[16],
          borderBottomWidth: 1,
          borderColor: c().border,
        }
      : { ...row, gap: space[8] };
  return (
    <View
      style={{
        gap: props.plain ? 0 : space[8],
        borderTopWidth: props.plain ? 1 : 0,
        borderColor: c().border,
      }}
    >
      <View style={line()}>
        <Label
          variant={props.plain ? "caption" : "body"}
          tone="muted"
          style={{ width: props.plain ? control.touch : space[64] }}
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
          variant={props.plain ? "caption" : "body"}
          tone="muted"
          style={{ width: props.plain ? control.touch : space[64] }}
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
          style={{
            ...fieldStyle(),
            // A token's characters spaced apart, in em of the field's text.
            ...(props.tablet && props.token
              ? { letterSpacing: tracked("caps", type("body").size) }
              : {}),
            ...(props.plain && props.token
              ? { letterSpacing: tracked("caps", type("subtitle").size) }
              : {}),
            ...(props.tokenWrong ? { borderColor: c().ink } : {}),
          }}
        />
      </View>
    </View>
  );
}
