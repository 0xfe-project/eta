import { Image, View } from "nsh";
import photo from "../../../assets/onboard.jpg";
import { colors, fill, Label } from "../../components";
import { weight } from "../../components/tokens";
import { uiText } from "../../i18n";

export function ConnectionIntro(props: { phone: boolean }) {
  return (
    <View style={{ gap: props.phone ? 12 : 6 }}>
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
      <View style={{ gap: 2, paddingVertical: 4 }}>
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
        paddingHorizontal: 12,
        paddingVertical: 8,
        gap: 2,
        cursor: props.disabled ? "default" : "pointer",
        opacity: props.disabled ? 0.5 : 1,
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
        height: 295,
        flexShrink: 0,
        justifyContent: "flex-end",
        padding: 16,
        gap: 8,
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
        variant="display"
        weight={weight.strong}
        style={{
          // design-value: text over the photograph, the same in either theme
          color: "#ffffff",
          maxWidth: 320,
          letterSpacing: -0.9,
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
