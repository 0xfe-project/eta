import { Image, View } from "nsh";
import photo from "../../../assets/onboard.jpg";
import { fill, Label, row } from "../../components";
import { weight } from "../../components/tokens";
import { uiText } from "../../i18n";

export function WelcomeStep(props: { phone: boolean }) {
  return (
    <>
      <View style={{ height: props.phone ? 200 : 272, position: "relative" }}>
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
      <View style={{ paddingHorizontal: 16, paddingVertical: 24, gap: 16 }}>
        <View style={{ gap: 6 }}>
          <Label
            variant="title"
            weight={weight.strong}
            style={{ letterSpacing: -0.2 }}
          >
            {uiText("welcomeToEta")}
          </Label>
          <Label tone="mutedInk">{uiText("twoShortStepsThenYourAgents")}</Label>
        </View>
        <View style={{ gap: 6 }}>
          <View style={{ ...row, gap: 10 }}>
            <Label variant="small" tone="muted" style={{ width: 16 }}>
              1
            </Label>
            <Label>{uiText("connectAModel")}</Label>
          </View>
          <View style={{ ...row, gap: 10 }}>
            <Label variant="small" tone="muted" style={{ width: 16 }}>
              2
            </Label>
            <Label>{uiText("installAgents")}</Label>
          </View>
        </View>
      </View>
    </>
  );
}
