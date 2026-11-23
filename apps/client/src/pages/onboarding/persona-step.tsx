import { View } from "nsh";
import { colors, Icon, Label, row } from "../../components";
import { CheckControl } from "../../components/check-control";
import { icon, opacity, space, weight } from "../../components/tokens";
import { uiText } from "../../i18n";

export interface Persona {
  id: string;
  name: string;
  description: string;
}

// Skeleton bars of the two placeholder rows: name and description widths.
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
  const bar = (width: number, height: number) => (
    <View
      style={{
        width,
        maxWidth: "100%",
        height,
        flexShrink: 0,
        backgroundColor: c().border,
      }}
    />
  );
  return (
    <View role="progressbar" accessibilityLabel={uiText("loadingAgents")}>
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
            <View
              style={{
                width: space[16],
                height: space[16],
                marginTop: space[2],
                flexShrink: 0,
                backgroundColor: c().border,
              }}
            />
            <View
              style={{
                flex: 1,
                minWidth: 0,
                gap: space[4],
                paddingTop: space[4],
              }}
            >
              {bar(widths()[0], 12)}
              {bar(widths()[1], 10)}
            </View>
            <View
              style={{
                ...row,
                width: 96,
                height: space[20],
                flexShrink: 0,
                justifyContent: "flex-end",
              }}
            >
              {bar(40, 10)}
            </View>
          </View>
        )}
      </Each>
    </View>
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
}) {
  const c = colors();
  const emptyState = {
    alignItems: "center",
    paddingVertical: space[40],
    paddingHorizontal: space[24],
    gap: space[8],
  } as const;
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
        <If when={props.loading}>
          <PersonaSkeleton phone={props.phone} />
        </If>
        <If when={props.missing}>
          <View style={emptyState}>
            <Icon name="warning" size={icon.md} tone="red" />
            <Label weight={weight.regular} style={{ textAlign: "center" }}>
              {uiText("unableToLoadAgents")}
            </Label>
            <Label
              variant="small"
              tone="muted"
              style={{ maxWidth: 320, textAlign: "center" }}
            >
              {props.missingReason || uiText("theHostDidntAnswerCheckYour")}
            </Label>
          </View>
        </If>
        <If when={!(props.missing || props.loading || props.cards.length)}>
          <View style={emptyState}>
            <Label weight={weight.regular} style={{ textAlign: "center" }}>
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
                size={icon.md}
                markSize={12}
                indicatorStyle={{
                  marginTop: space[2],
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
                  paddingHorizontal: space[16],
                  paddingVertical: space[12],
                  gap: space[12],
                  borderBottomWidth:
                    card().id === props.cards.at(-1)?.id ? 0 : 1,
                  borderColor: c().border,
                  alignItems: "flex-start",
                  opacity: props.working && !checked() ? opacity.disabled : 1,
                }}
              >
                <View style={{ flex: 1, gap: space[2] }}>
                  <Label weight={weight.regular}>{card().name}</Label>
                  <Label variant="small" tone="muted">
                    {card().description}
                  </Label>
                </View>
                <View
                  style={{ width: 96, flexShrink: 0, alignItems: "flex-end" }}
                >
                  <If when={installed()}>
                    <View style={{ ...row, height: space[20], gap: space[4] }}>
                      <If when={props.installedHere(card().id)}>
                        <Icon name="check" size={icon.sm} />
                      </If>
                      <Label
                        variant="small"
                        tone={props.installedHere(card().id) ? "ink" : "muted"}
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
                          width: 96,
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
            );
          }}
        </Each>
      </View>
    </>
  );
}
