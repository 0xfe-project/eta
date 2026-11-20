import { View } from "nsh";
import { colors, Icon, Label, row } from "../../components";
import { CheckControl } from "../../components/check-control";
import { uiText } from "../../i18n";

export interface Persona {
  id: string;
  name: string;
  description: string;
}

export function PersonaStep(props: {
  cards: Persona[];
  loading: boolean;
  missing: boolean;
  working: boolean;
  activeCard: string;
  error: string;
  installedCount: number;
  total: number;
  installed: (id: string) => boolean;
  selected: (id: string) => boolean;
  onToggle: (id: string) => void;
}) {
  const c = colors();
  return (
    <>
      <View
        style={{
          padding: 16,
          paddingTop: 24,
          borderBottomWidth: 1,
          borderColor: c().border,
          gap: 4,
        }}
      >
        <Label size={16} weight={600}>
          {props.working
            ? uiText("gettingYourAgentsReady")
            : uiText("whoWouldYouLikeToWork")}
        </Label>
        <Label tone="mutedInk">
          {props.working
            ? uiText("youllLandInChatAsSoon")
            : uiText("pickAFewToStart")}
        </Label>
      </View>
      <If when={props.loading}>
        <Label tone="muted" style={{ padding: 16 }}>
          {uiText("loadingAgents")}
        </Label>
      </If>
      <If when={props.missing}>
        <View
          style={{
            flex: 1,
            minHeight: 160,
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
            gap: 6,
          }}
        >
          <Icon name="info" tone="red" />
          <Label weight={500}>{uiText("unableToLoadAgents")}</Label>
          <Label size={12} tone="muted">
            {uiText("theHostDidntAnswerCheckYour")}
          </Label>
        </View>
      </If>
      <If when={!(props.missing || props.loading || props.cards.length)}>
        <View
          style={{
            minHeight: 108,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Label>{uiText("noPersonaCardsToInstall")}</Label>
        </View>
      </If>
      <Each of={props.cards} key={(card) => card.id}>
        {(card) => {
          const checked = () =>
            props.installed(card().id) || props.selected(card().id);
          return (
            <CheckControl
              label={card().name}
              checked={checked()}
              disabled={props.installed(card().id) || props.working}
              onChange={() => props.onToggle(card().id)}
              size={16}
              markSize={11}
              indicatorStyle={{
                marginTop: 2,
                borderColor: checked() ? c().button : c().strong,
                opacity: props.installed(card().id) ? 0.3 : 1,
              }}
              style={{
                ...row,
                paddingHorizontal: 16,
                paddingVertical: 10,
                gap: 12,
                borderBottomWidth: 1,
                borderColor: c().border,
                alignItems: "flex-start",
              }}
            >
              <View style={{ flex: 1, gap: 2 }}>
                <Label weight={500}>{card().name}</Label>
                <Label size={12} line={16} tone="muted">
                  {card().description}
                </Label>
              </View>
              <If when={props.installed(card().id)}>
                <Label size={12} tone="muted">
                  {uiText("installed")}
                </Label>
              </If>
              <If
                when={
                  props.activeCard === card().id && !props.installed(card().id)
                }
              >
                <View style={{ gap: 5, alignItems: "flex-end" }}>
                  <Label size={12} tone="muted">
                    {uiText("installing")}
                  </Label>
                  <View
                    style={{
                      width: 96,
                      height: 2,
                      backgroundColor: c().border,
                    }}
                  >
                    <View
                      style={{
                        height: 2,
                        backgroundColor: c().ink,
                        width: `${Math.max(20, (100 * (props.installedCount + 0.5)) / Math.max(1, props.total))}%`,
                      }}
                    />
                  </View>
                </View>
              </If>
            </CheckControl>
          );
        }}
      </Each>
      <If when={props.error}>
        <Label
          size={12}
          line={16}
          tone="red"
          style={{ padding: 14, backgroundColor: c().redFill }}
        >
          {uiText("installFailed")}
          {props.error}
        </Label>
      </If>
    </>
  );
}
