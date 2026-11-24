import { safeAreaInsets, View } from "nsh";
import { colors, grow, Label, row } from "../../components";
import { space } from "../../components/tokens";
import { uiText } from "../../i18n";

export function PhoneHostSetup(props: { noModel: boolean; hostName?: string }) {
  const c = colors();
  const insets = safeAreaInsets();
  const hostname = () => {
    if (!props.hostName) return "This host";
    const name = new URL(props.hostName).hostname;
    return /^\d+\./.test(name) ? name : name.split(".")[0];
  };
  return (
    <View style={grow}>
      <View
        style={{
          paddingHorizontal: space[16],
          paddingTop: space[32],
          paddingBottom: space[24],
          gap: space[8],
        }}
      >
        <Label variant="title">
          {uiText("isntReadyYet", { hostname: hostname() })}
        </Label>
        <Label variant="small" tone="muted">
          {props.noModel
            ? uiText("twoStepsLeftOpenEtaOn")
            : uiText("oneStepLeftOpenEtaOn")}
        </Label>
      </View>
      <View style={{ borderTopWidth: 1, borderColor: c().border }}>
        <If when={props.noModel}>
          <SetupStep
            number={1}
            title={uiText("bindAModel")}
            detail={uiText("thereIsNoProviderYetAdd")}
          />
        </If>
        <SetupStep
          number={props.noModel ? 2 : 1}
          title={uiText("installAnAgent")}
          detail={uiText("agentsAreWhoYouTalkTo")}
          waiting={props.noModel}
        />
      </View>
      <View style={{ ...grow }} />
      <Label
        variant="small"
        tone="muted"
        style={{
          paddingHorizontal: space[16],
          paddingTop: space[16],
          paddingBottom: Math.max(4, 34 - insets().bottom),
        }}
      >
        {uiText("thisPageUpdatesByItselfWhen")}
      </Label>
    </View>
  );
}

function SetupStep(props: {
  number: number;
  title: string;
  detail: string;
  waiting?: boolean;
}) {
  const c = colors();
  return (
    <View
      style={{
        ...row,
        alignItems: "flex-start",
        paddingVertical: space[16],
        paddingHorizontal: space[16],
        gap: space[16],
        borderBottomWidth: 1,
        borderColor: c().border,
      }}
    >
      <Label
        variant="small"
        tone={props.waiting ? "faint" : "ink"}
        style={{ width: space[16] }}
      >
        {props.number}
      </Label>
      <View style={{ ...grow, gap: space[4] }}>
        <Label tone={props.waiting ? "muted" : "ink"}>{props.title}</Label>
        <Label variant="small" tone="muted">
          {props.detail}
        </Label>
      </View>
    </View>
  );
}
