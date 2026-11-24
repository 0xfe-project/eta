import { Image, View } from "nsh";
import photo from "../../../assets/onboard.jpg";
import { colors, fill, Label } from "../../components";
import { opacity, space, weight } from "../../components/tokens";
import { uiText } from "../../i18n";

/** The connection card's width off phones (the form, an error, a download). */
export const cardWidth = 480;
/** The phone hero's photograph, and how wide its headline runs over it. */
const heroHeight = 296;
const headlineWidth = 320;

export function ConnectionIntro(props: { phone: boolean }) {
  return (
    <View style={{ gap: props.phone ? space[12] : space[4] }}>
      <Label variant="subtitle">{uiText("connectToOneHostReachEvery")}</Label>
      <Label variant="small" tone="muted">
        {uiText("thePhoneIsOnlyAScreen")}
      </Label>
    </View>
  );
}

export function ConnectionMessage(props: { error: string; detail?: string }) {
  return (
    <If when={props.error}>
      <View style={{ gap: space[2], paddingVertical: space[4] }}>
        <Label>{props.error}</Label>
        <If when={props.detail}>
          <Label variant="small" tone="muted">
            {props.detail}
          </Label>
        </If>
      </View>
    </If>
  );
}

export function LocationOption(props: {
  title: string;
  description: string;
  selected: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const c = colors();
  return (
    <View
      role="button"
      accessibilityLabel={props.title}
      accessibilityState={{
        disabled: props.disabled,
        selected: props.selected,
      }}
      onPress={() => {
        if (!props.disabled) props.onPress();
      }}
      hoverStyle={props.disabled ? undefined : { backgroundColor: c().surface }}
      style={{
        borderColor: props.selected ? c().ink : c().strong,
        borderWidth: 1,
        paddingHorizontal: space[12],
        paddingVertical: space[8],
        gap: space[2],
        cursor: props.disabled ? "default" : "pointer",
        opacity: props.disabled ? opacity.disabled : 1,
      }}
    >
      <Label>{props.title}</Label>
      <Label variant="small" tone="muted">
        {props.description}
      </Label>
    </View>
  );
}

export function PhoneHero() {
  return (
    <View
      style={{
        height: heroHeight,
        flexShrink: 0,
        justifyContent: "flex-end",
        padding: space[16],
        gap: space[8],
      }}
    >
      <Image
        src={photo}
        fadeDuration={0}
        style={{
          ...fill,
          width: "100%",
          height: "100%",
          objectFit: "cover",
          objectPosition: "50% 30%",
        }}
      />
      <View
        style={{
          ...fill,
          backgroundImage:
            "linear-gradient(0deg, #000000c7 0%, #00000080 40%, #00000000 70%)",
        }}
      />
      <View
        style={{
          ...fill,
          backgroundImage:
            "linear-gradient(180deg, #00000099 0%, #00000040 14%, #00000000 28%)",
        }}
      />
      <Label
        tracking="tight"
        variant="display"
        weight={weight.strong}
        style={{
          // design-value: text over the photograph, the same in either theme
          color: "#ffffff",
          maxWidth: headlineWidth,
        }}
      >
        {uiText("yourMachinesInYourPocket")}
      </Label>
      <Label
        variant="caption"
        // design-value: text over the photograph, the same in either theme
        style={{ color: "#ffffffbf" }}
      >
        Photo: Barnabas Davoti / Unsplash
      </Label>
    </View>
  );
}
