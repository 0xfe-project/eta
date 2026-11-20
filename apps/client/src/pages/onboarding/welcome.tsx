import { Image, View } from "nsh";
import photo from "../../../assets/onboard.jpg";
import { fill, Label, row } from "../../components";
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
          size={10}
          line={14}
          style={{
            position: "absolute",
            right: 12,
            bottom: 10,
            color: "#ffffffb3",
          }}
        >
          Photo: Barnabas Davoti / Unsplash
        </Label>
      </View>
      <View style={{ padding: 16, paddingTop: 24, gap: 7 }}>
        <Label size={20} line={28} weight={600}>
          {uiText("welcomeToEta")}
        </Label>
        <Label tone="mutedInk">{uiText("twoShortStepsThenYourAgents")}</Label>
        <View style={{ gap: 5, paddingTop: 8 }}>
          <View style={{ ...row, gap: 10 }}>
            <Label size={12} tone="muted" style={{ width: 16 }}>
              1
            </Label>
            <Label>{uiText("connectAModel")}</Label>
          </View>
          <View style={{ ...row, gap: 10 }}>
            <Label size={12} tone="muted" style={{ width: 16 }}>
              2
            </Label>
            <Label>{uiText("installAgents")}</Label>
          </View>
        </View>
      </View>
    </>
  );
}
