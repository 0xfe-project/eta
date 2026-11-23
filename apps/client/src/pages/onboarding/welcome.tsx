import { Image, View } from "nsh";
import photo from "../../../assets/onboard.jpg";
import { fill, Label, row } from "../../components";
import { space, weight } from "../../components/tokens";
import { uiText } from "../../i18n";

/** The photograph atop the welcome step. */
const photoHeight = { phone: 200, other: 272 } as const;

export function WelcomeStep(props: { phone: boolean }) {
  return (
    <>
      <View
        style={{
          height: props.phone ? photoHeight.phone : photoHeight.other,
          position: "relative",
        }}
      >
        <Image
          src={photo}
          style={{
            ...fill,
            width: "100%",
            height: "100%",
            objectFit: "cover",
            objectPosition: "50% 40%",
          }}
          fadeDuration={0}
        />
        <View
          style={{
            ...fill,
            backgroundImage:
              "linear-gradient(0deg, #00000059 0%, #00000000 30%)",
          }}
        />
        <Label
          variant="caption"
          style={{
            position: "absolute",
            right: 12,
            bottom: 10,
            color: "#ffffffb3", // design-value: text over the photograph, which is the same in either theme
          }}
        >
          Photo: Barnabas Davoti / Unsplash
        </Label>
      </View>
      <View
        style={{
          paddingHorizontal: space[16],
          paddingVertical: space[24],
          gap: space[16],
        }}
      >
        <View style={{ gap: space[4] }}>
          <Label tracking="tight" variant="title" weight={weight.strong}>
            {uiText("welcomeToEta")}
          </Label>
          <Label tone="mutedInk">{uiText("twoShortStepsThenYourAgents")}</Label>
        </View>
        <View style={{ gap: space[4] }}>
          <View style={{ ...row, gap: space[8] }}>
            <Label variant="small" tone="muted" style={{ width: space[16] }}>
              1
            </Label>
            <Label>{uiText("connectAModel")}</Label>
          </View>
          <View style={{ ...row, gap: space[8] }}>
            <Label variant="small" tone="muted" style={{ width: space[16] }}>
              2
            </Label>
            <Label>{uiText("installAgents")}</Label>
          </View>
        </View>
      </View>
    </>
  );
}
