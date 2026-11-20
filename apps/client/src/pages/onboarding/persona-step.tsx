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
  missingReason: string;
  working: boolean;
  activeCard: string;
  installedCount: number;
  total: number;
  installed: (id: string) => boolean;
  installedHere: (id: string) => boolean;
  selected: (id: string) => boolean;
  onToggle: (id: string) => void;
}) {
  const c = colors();
  const emptyState = {
    alignItems: "center",
    paddingVertical: 40,
    paddingHorizontal: 24,
    gap: 8,
  } as const;
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
      <View style={{ paddingBottom: 8 }}>
        <If when={props.loading}>
          <Label tone="muted" style={{ padding: 16 }}>
            {uiText("loadingAgents")}
          </Label>
        </If>
        <If when={props.missing}>
          <View style={emptyState}>
            <Icon name="warning" size={16} tone="red" />
            <Label weight={500} style={{ textAlign: "center" }}>
              {uiText("unableToLoadAgents")}
            </Label>
            <Label
              size={12}
              line={16}
              tone="muted"
              style={{ maxWidth: 320, textAlign: "center" }}
            >
              {props.missingReason || uiText("theHostDidntAnswerCheckYour")}
            </Label>
          </View>
        </If>
        <If when={!(props.missing || props.loading || props.cards.length)}>
          <View style={emptyState}>
            <Label weight={500} style={{ textAlign: "center" }}>
              {uiText("noPersonaCardsToInstall")}
            </Label>
          </View>
        </If>
        <Each of={props.cards} key={(card) => card.id}>
          {(card) => {
            const installed = () => props.installed(card().id);
            const checked = () => installed() || props.selected(card().id);
            // Installed rows, and every row on its way in, show the settled grey box.
            const settled = () => installed() || (props.working && checked());
            const active = () => props.activeCard === card().id && !installed();
            return (
              <CheckControl
                label={card().name}
                checked={checked()}
                disabled={installed() || props.working}
                onChange={() => props.onToggle(card().id)}
                size={16}
                markSize={12}
                indicatorStyle={{
                  marginTop: 2,
                  borderColor: settled()
                    ? c().strong
                    : checked()
                      ? c().button
                      : c().strong,
                  backgroundColor: settled()
                    ? c().strong
                    : checked()
                      ? c().button
                      : c().canvas,
                }}
                style={{
                  ...row,
                  paddingHorizontal: 16,
                  paddingVertical: 10,
                  gap: 12,
                  borderBottomWidth:
                    card().id === props.cards.at(-1)?.id ? 0 : 1,
                  borderColor: c().border,
                  alignItems: "flex-start",
                  opacity: props.working && !checked() ? 0.5 : 1,
                }}
              >
                <View style={{ flex: 1, gap: 2 }}>
                  <Label weight={500}>{card().name}</Label>
                  <Label size={12} line={16} tone="muted">
                    {card().description}
                  </Label>
                </View>
                <View
                  style={{ width: 96, flexShrink: 0, alignItems: "flex-end" }}
                >
                  <If when={installed()}>
                    <View style={{ ...row, height: 20, gap: 4 }}>
                      <If when={props.installedHere(card().id)}>
                        <Icon name="check" size={12} />
                      </If>
                      <Label
                        size={12}
                        line={16}
                        tone={props.installedHere(card().id) ? "ink" : "muted"}
                      >
                        {uiText("installed")}
                      </Label>
                    </View>
                  </If>
                  <If when={active()}>
                    <View
                      style={{ gap: 6, paddingTop: 2, alignItems: "flex-end" }}
                    >
                      <Label size={12} line={16}>
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
                  <If when={!installed() && !active()}>
                    <View style={{ height: 20 }} />
                  </If>
                </View>
              </CheckControl>
            );
          }}
        </Each>
      </View>
    </>
  );
}
