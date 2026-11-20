import { Image, View } from "nsh";
import photo from "../../../assets/onboard.jpg";
import { colors, fill, Label } from "../../components";
import { uiText } from "../../i18n";

export function ConnectionIntro(props: { phone: boolean }) {
  return (
    <View style={{ gap: props.phone ? 12 : 6 }}>
      <Label size={18} line={26}>
        {uiText("connectToOneHostReachEvery")}
      </Label>
      <Label size={12} line={18} tone="muted">
        {uiText("thePhoneIsOnlyAScreen")}
      </Label>
    </View>
  );
}

export function ConnectionMessage(props: { error: string; detail?: string }) {
  const c = colors();
  return (
    <If when={props.error}>
      <View
        style={{
          gap: 3,
          paddingHorizontal: 12,
          paddingVertical: 8,
          borderLeftWidth: 2,
          borderColor: c().red,
          backgroundColor: c().redFill,
        }}
      >
        <Label size={12} line={16} tone="red">
          {props.error}
        </Label>
        <If when={props.detail}>
          <Label size={12} line={16} tone="mutedInk">
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
        borderColor: props.selected && !props.disabled ? c().ink : c().strong,
        borderWidth: 1,
        paddingHorizontal: 12,
        paddingVertical: 8,
        gap: 2,
        cursor: props.disabled ? "default" : "pointer",
      }}
    >
      <Label>{props.title}</Label>
      <Label size={12} line={16} tone="muted">
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
        size={30}
        line={34}
        weight={600}
        style={{ color: "#ffffff", maxWidth: 320, letterSpacing: -0.9 }}
      >
        {uiText("yourMachinesInYourPocket")}
      </Label>
      <Label size={10} line={12} style={{ color: "#ffffffbf" }}>
        Photo: Barnabas Davoti / Unsplash
      </Label>
    </View>
  );
}
