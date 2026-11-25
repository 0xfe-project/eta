import { View } from "nsh";
import {
  colors,
  Icon,
  Label,
  Revealed,
  row,
  SkeletonBar,
  SkeletonReveal,
} from "../../components";
import { CheckControl } from "../../components/check-control";
import { EmptyState } from "../../components/empty-state";
import { settled } from "../../components/pending";
import { icon, opacity, space, weight } from "../../components/tokens";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";
import { problemText } from "../../services/problem-text";

export interface Persona {
  id: string;
  name: string;
  description: string;
}

// Skeleton bars of the two placeholder rows: name and description widths, a line of text tall;
// the trailing bar stands for the row's state.
const lineHeight = 12;
const stateBarWidth = 40;
/** The column at a row's end: its state, or the install bar. */
const stateWidth = 96;
const skeletonRows = {
  wide: [
    [88, 420],
    [120, 340],
  ],
  phone: [
    [88, 220],
    [120, 180],
  ],
};

/** Loading · persona rows: a checkbox square, a name bar, a description bar
 * and a short trailing bar, two rows as on the web. */
function PersonaSkeleton(props: { phone: boolean }) {
  const c = colors();
  return (
    <Revealed>
      <View
        role="progressbar"
        accessibilityLabel={uiText("loadingAgents")}
        accessibilityState={{ busy: true }}
      >
        <Each of={props.phone ? skeletonRows.phone : skeletonRows.wide}>
          {(widths) => (
            <View
              style={{
                ...row,
                alignItems: "flex-start",
                paddingHorizontal: space[16],
                paddingVertical: space[12],
                gap: space[12],
                borderBottomWidth: 1,
                borderColor: c().border,
              }}
            >
              <SkeletonBar
                width={space[16]}
                height={space[16]}
                style={{ marginTop: space[2] }}
              />
              <View
                style={{
                  flex: 1,
                  minWidth: 0,
                  gap: space[4],
                  paddingTop: space[4],
                }}
              >
                <SkeletonBar width={widths()[0]} height={lineHeight} />
                <SkeletonBar width={widths()[1]} height={lineHeight} />
              </View>
              <View
                style={{
                  ...row,
                  width: stateWidth,
                  height: space[20],
                  flexShrink: 0,
                  justifyContent: "flex-end",
                }}
              >
                <SkeletonBar width={stateBarWidth} height={lineHeight} />
              </View>
            </View>
          )}
        </Each>
      </View>
    </Revealed>
  );
}

export function PersonaStep(props: {
  phone: boolean;
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
  onRetry?: () => void;
}) {
  const c = colors();
  const ready = settled(() => !props.loading);
  const host = useHost();
  return (
    <>
      <View
        style={{
          padding: space[16],
          paddingTop: space[24],
          borderBottomWidth: 1,
          borderColor: c().border,
          gap: space[4],
        }}
      >
        <Label variant="subtitle" weight={weight.strong}>
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
      <View style={{ paddingBottom: space[8] }}>
        <If when={!ready()}>
          <PersonaSkeleton phone={props.phone} />
        </If>
        <If when={ready() && (props.missing || !props.cards.length)}>
          <EmptyState
            size="card"
            status={props.missing ? "error" : "empty"}
            loading={null}
            error={{
              title: uiText("unableToLoadAgents"),
              description:
                problemText(props.missingReason) ||
                uiText("theHostDidntAnswerCheckYour"),
              problem: props.missingReason || undefined,
              retry: host.wake,
            }}
            empty={{ title: uiText("noPersonaCardsToInstall") }}
          />
        </If>
        <If when={ready()}>
          <Each of={props.cards} key={(card) => card.id}>
            {(card, index) => {
              const installed = () => props.installed(card().id);
              const checked = () => installed() || props.selected(card().id);
              // Installed rows, and every row on its way in, show the settled grey box.
              const settledRow = () =>
                installed() || (props.working && checked());
              const active = () =>
                props.activeCard === card().id && !installed();
              return (
                <SkeletonReveal index={index()}>
                  <CheckControl
                    label={card().name}
                    checked={checked()}
                    disabled={installed() || props.working}
                    onChange={() => props.onToggle(card().id)}
                    size={icon.md}
                    markSize={icon.sm}
                    indicatorStyle={{
                      marginTop: space[2],
                      borderColor: settledRow()
                        ? c().strong
                        : checked()
                          ? c().button
                          : c().strong,
                      backgroundColor: settledRow()
                        ? c().strong
                        : checked()
                          ? c().button
                          : c().canvas,
                    }}
                    style={{
                      ...row,
                      paddingHorizontal: space[16],
                      paddingVertical: space[12],
                      gap: space[12],
                      borderBottomWidth:
                        card().id === props.cards.at(-1)?.id ? 0 : 1,
                      borderColor: c().border,
                      alignItems: "flex-start",
                      opacity:
                        props.working && !checked() ? opacity.disabled : 1,
                    }}
                  >
                    <View style={{ flex: 1, gap: space[2] }}>
                      <Label weight={weight.regular}>{card().name}</Label>
                      <Label variant="small" tone="muted">
                        {card().description}
                      </Label>
                    </View>
                    <View
                      style={{
                        width: stateWidth,
                        flexShrink: 0,
                        alignItems: "flex-end",
                      }}
                    >
                      <If when={installed()}>
                        <View
                          style={{ ...row, height: space[20], gap: space[4] }}
                        >
                          <If when={props.installedHere(card().id)}>
                            <Icon name="check" size={icon.sm} />
                          </If>
                          <Label
                            variant="small"
                            tone={
                              props.installedHere(card().id) ? "ink" : "muted"
                            }
                          >
                            {uiText("installed")}
                          </Label>
                        </View>
                      </If>
                      <If when={active()}>
                        <View
                          style={{
                            gap: space[4],
                            paddingTop: space[2],
                            alignItems: "flex-end",
                          }}
                        >
                          <Label variant="small">{uiText("installing")}</Label>
                          <View
                            style={{
                              width: stateWidth,
                              height: space[2],
                              backgroundColor: c().border,
                            }}
                          >
                            <View
                              style={{
                                height: space[2],
                                backgroundColor: c().ink,
                                width: `${Math.max(20, (100 * (props.installedCount + 0.5)) / Math.max(1, props.total))}%`,
                              }}
                            />
                          </View>
                        </View>
                      </If>
                      <If when={!installed() && !active()}>
                        <View style={{ height: space[20] }} />
                      </If>
                    </View>
                  </CheckControl>
                </SkeletonReveal>
              );
            }}
          </Each>
        </If>
      </View>
    </>
  );
}
