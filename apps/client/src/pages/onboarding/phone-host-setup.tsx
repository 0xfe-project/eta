import { safeAreaInsets, View } from "nsh";
import { normalizeHostOrigin, useSavedHosts } from "../../app/saved-hosts";
import {
  Button,
  colors,
  grow,
  Label,
  row,
  SmoothScroll,
} from "../../components";
import { control, space } from "../../components/tokens";
import { uiText } from "../../i18n";

export function PhoneHostSetup(props: {
  noModel: boolean;
  hostName?: string;
  onContinue?: () => void;
  onConnect?: () => void;
}) {
  const c = colors();
  const insets = safeAreaInsets();
  const savedHosts = useSavedHosts();
  const hostname = () => {
    if (!props.hostName) return uiText("thisHost");
    const normalized = normalizeHostOrigin(props.hostName);
    if (normalized) {
      const saved = savedHosts
        .hosts()
        .find((item) => item.origin === normalized);
      if (saved?.name) return saved.name;
    }
    try {
      const name = new URL(props.hostName).hostname;
      return /^\d+\./.test(name) ? name : (name.split(".")[0] ?? name);
    } catch {
      return props.hostName;
    }
  };
  return (
    <SmoothScroll style={grow} contentStyle={{ flexGrow: 1 }}>
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
      <View
        style={{
          paddingHorizontal: space[16],
          paddingTop: space[16],
          paddingBottom: Math.max(space[16], space[32] - insets().bottom),
          gap: space[12],
        }}
      >
        <Label variant="small" tone="muted">
          {uiText("thisPageUpdatesByItselfWhen")}
        </Label>
        <If when={props.onContinue || props.onConnect}>
          <View style={{ gap: space[8] }}>
            <If when={props.onContinue}>
              <Button
                label={uiText("setUpOnThisPhone")}
                tone="primary"
                size={control.touch}
                labelVariant="body"
                onPress={props.onContinue!}
              />
            </If>
            <If when={props.onConnect}>
              <Button
                label={uiText("changeHost")}
                size={control.touch}
                labelVariant="body"
                onPress={props.onConnect!}
              />
            </If>
          </View>
        </If>
      </View>
    </SmoothScroll>
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
