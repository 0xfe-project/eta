import type { ProvidersView } from "@eta/client-contracts";
import type { Persona } from "./persona-step";
import { cleanup, effect, signal, View } from "nsh";
import {
  Button,
  colors,
  dialogWidth,
  grow,
  Header,
  Icon,
  Label,
  Modal,
  row,
  SmoothScroll,
} from "../../components";
import { useModels } from "../../components/model-select";
import { formatRemaining } from "../../components/progress-notification";
import { StatusDot } from "../../components/status-dot";
import { control, icon, opacity, space, weight } from "../../components/tokens";
import { uiText } from "../../i18n";
import { follow, useHost } from "../../services/host";
import { problemText } from "../../services/problem-text";
import { AddSource } from "../settings/models/add-source";
import { ProviderDetail } from "../settings/models/provider-detail";
import { PersonaStep } from "./persona-step";
import { WelcomeStep } from "./welcome";

// Footer buttons: 12pt from the edge to the label (the primary's 1pt border
// counts), 8 before a leading icon, a 6pt gap, and half opacity when disabled.
const footerButton = (disabled = false) => ({
  paddingHorizontal: space[12],
  gap: space[4],
  opacity: disabled ? opacity.disabled : 1,
});
// On a phone the footer's buttons are touch height, as is step 1's first Add source.
const phoneButton = control.touch;
/** A source row's trailing state (a dot and its model count). */
const sourceStateWidth = 80;
/** The provider dialog's height: most of a phone's screen, a fixed one elsewhere. */
const providerHeight = { phone: "90%", other: 560 } as const;

/** "A", "A and B", "A, B and C". */
function listText(items: string[]) {
  if (items.length < 2) return items.join("");
  return uiText("listAnd", {
    items: items.slice(0, -1).join(uiText("listSeparator")),
    last: items.at(-1),
  });
}

export function Onboard(props: { phone: boolean; onClose: () => void }) {
  const host = useHost();
  const c = colors();
  const step = signal(0);
  const adding = signal(false);
  const detail = signal("");
  const unchecked = signal<string[]>([]);
  const installedHere = signal<string[]>([]);
  const working = signal(false);
  const activeCard = signal("");
  const error = signal("");
  const total = signal(0);
  const installStartedAt = signal(0);
  const installClock = signal(0);
  const retryTick = signal(0);
  effect(() => {
    if (!working()) return;
    const timer = setInterval(() => installClock.set(Date.now()), 1000);
    cleanup(() => clearInterval(timer));
  });
  const installEta = () => {
    if (!working()) return "";
    const started = installStartedAt();
    const completed = installedHere().length;
    const target = total();
    if (!started || target <= 0) return "";
    const elapsed = Math.max(0, installClock() - started);
    if (elapsed < 1000 || completed <= 0) return uiText("progressEstimating");
    if (completed >= target) return "";
    return formatRemaining((elapsed * (target - completed)) / completed);
  };
  const cardsMissing = () =>
    host.state().missing.personas || host.state().status === "reconnecting";
  const loadingCards = () => !host.state().targets.personas && !cardsMissing();
  follow(() => {
    retryTick();
    return "personas";
  });
  const providers = () => host.section<ProvidersView>("providers", "config");
  const models = useModels();
  const sources = () =>
    (providers()?.providers ?? []).filter((source) => source.id !== "llm");
  const cards = () => host.list<Persona>("personas", "cards");
  const installed = (id: string) =>
    installedHere().includes(id) ||
    host.people().some((agent) => agent.persona === id);
  const selected = () =>
    cards().filter(
      (card) => !installed(card.id) && !unchecked().includes(card.id),
    );
  // The agents get the first usable model, as on the web.
  const chosenModel = () => models()[0]?.id;
  const installBlocked = () =>
    working() ||
    !chosenModel() ||
    !selected().length ||
    Boolean(cardsMissing());
  const already = () => cards().filter((card) => installed(card.id)).length;
  const showCount = () =>
    step() === 3 ||
    (step() === 2 && !cardsMissing() && !loadingCards() && cards().length > 0);
  async function install() {
    const model = chosenModel();
    if (!model || working()) return;
    const queue = selected();
    const now = Date.now();
    installStartedAt.set(now);
    installClock.set(now);
    working.set(true);
    error.set("");
    total.set(installedHere().length + queue.length);
    try {
      for (const card of queue) {
        if (installed(card.id)) continue;
        activeCard.set(card.id);
        await host.call("agents", "create", {
          name: card.name,
          persona: card.id,
          model,
        });
        installedHere.update((ids) => [...ids, card.id]);
        installClock.set(Date.now());
      }
      step.set(3);
    } catch (cause) {
      error.set(problemText(cause));
    } finally {
      working.set(false);
      activeCard.set("");
    }
  }

  return (
    <>
      <Modal
        title={uiText("setUpEta")}
        phone={props.phone}
        // A phone gets the whole screen, as the web's /onboard page.
        phonePage={props.phone}
        overPhoneNavigation={props.phone}
        width={dialogWidth.xl}
        height={props.phone ? "100%" : undefined}
        onClose={props.onClose}
        dismissible={false}
        hideHeader
      >
        <Header
          title={uiText("setUpEta")}
          layout="desktop"
          dialog
          inset={space[16]}
          end={space[12]}
        />
        <If when={step() > 0}>
          <View
            style={{
              ...row,
              height: space[40],
              flexShrink: 0,
              paddingHorizontal: space[16],
              gap: space[12],
              borderBottomWidth: 1,
              borderColor: c().border,
            }}
          >
            <View style={{ ...row, gap: space[8] }}>
              <If when={step() < 3} else={<Icon name="check" size={icon.sm} />}>
                <Label tracking="caps" variant="caption" tone="muted">
                  {`${step()}/2`}
                </Label>
              </If>
              <Label variant="small" weight={weight.strong}>
                {step() === 1
                  ? uiText("connectAModel")
                  : step() === 2
                    ? uiText("installAgents")
                    : uiText("complete")}
              </Label>
            </View>
            <Label
              variant="small"
              tone="muted"
              style={{ flex: 1, textAlign: "right" }}
            >
              {step() === 1
                ? uiText("nextInstallAgents")
                : step() === 2
                  ? uiText("lastStep")
                  : ""}
            </Label>
            <View style={{ ...row, gap: space[4] }}>
              <Each of={[1, 2]}>
                {(num) => (
                  <If
                    when={step() >= num()}
                    else={
                      <View
                        style={{
                          width: space[8],
                          height: space[8],
                          borderWidth: 1,
                          borderColor: c().strong,
                        }}
                      />
                    }
                  >
                    <StatusDot color={step() === num() ? c().ink : c().faint} />
                  </If>
                )}
              </Each>
            </View>
          </View>
        </If>
        <SmoothScroll
          style={props.phone ? grow : { flexShrink: 1, minHeight: 0 }}
          scrollbar={false}
        >
          <If when={step() === 0}>
            <WelcomeStep phone={props.phone} />
          </If>
          <If when={step() === 1}>
            <View
              style={{
                padding: space[16],
                paddingTop: space[24],
                gap: space[4],
              }}
            >
              <Label variant="subtitle" weight={weight.strong}>
                {uiText("whichModelShouldYourAgentsUse")}
              </Label>
              <Label tone="mutedInk">
                {sources().length
                  ? uiText(
                      sources().length > 1 ? "areConnected" : "isConnected",
                      {
                        names: listText(
                          sources().map((source) => source.name ?? source.id),
                        ),
                      },
                    )
                  : uiText("aSubscriptionAProviderApiKey")}
              </Label>
            </View>
            <View
              style={{
                paddingHorizontal: space[16],
                paddingBottom: space[24],
                gap: space[8],
              }}
            >
              <Each of={sources()} key={(source) => source.id}>
                {(source) => (
                  <View
                    role="button"
                    accessibilityLabel={source().name ?? source().id}
                    onPress={() => detail.set(source().id)}
                    hoverStyle={{ backgroundColor: c().selected }}
                    style={{
                      ...row,
                      alignItems: "flex-start",
                      gap: space[8],
                      paddingVertical: space[8],
                      paddingHorizontal: space[12],
                      borderWidth: 1,
                      borderColor: c().border,
                      cursor: "pointer",
                    }}
                  >
                    <View
                      style={{
                        width: space[24],
                        height: space[24],
                        flexShrink: 0,
                        alignItems: "center",
                        justifyContent: "center",
                        borderWidth: 1,
                        borderColor: c().strong,
                      }}
                    >
                      <Icon name="plugins" size={icon.md} />
                    </View>
                    <View style={{ flex: 1, minWidth: 0, gap: space[2] }}>
                      <Label weight={weight.regular}>
                        {source().name ?? source().id}
                      </Label>
                      <Label variant="small" tone="muted">
                        {[
                          ...(source().hasApiKey
                            ? [uiText("sourceApiKey")]
                            : []),
                          uiText("sourceModelCount", {
                            length: source().models.length,
                          }),
                        ].join(" · ")}
                      </Label>
                    </View>
                    <View
                      style={{
                        ...row,
                        width: sourceStateWidth,
                        height: space[20],
                        gap: space[4],
                        flexShrink: 0,
                      }}
                    >
                      <StatusDot
                        color={source().models.length ? c().green : c().warning}
                      />
                      <Label variant="small" tone="mutedInk">
                        {source().models.length
                          ? uiText("working2")
                          : uiText("needsAttention")}
                      </Label>
                    </View>
                    <View style={{ marginTop: space[2] }}>
                      <Icon name="right" size={icon.md} tone="mutedInk" />
                    </View>
                  </View>
                )}
              </Each>
              <Button
                label={uiText("addSource")}
                icon="plus"
                tone={sources().length ? "ghost" : "primary"}
                size={
                  sources().length
                    ? control.sm
                    : props.phone
                      ? phoneButton
                      : control.md
                }
                onPress={() => adding.set(true)}
                style={{
                  alignSelf: "flex-start",
                  gap: space[4],
                  paddingHorizontal: sources().length ? 0 : space[12],
                }}
              />
            </View>
          </If>
          <If when={step() === 2}>
            <PersonaStep
              phone={props.phone}
              cards={cards()}
              loading={loadingCards()}
              missing={Boolean(cardsMissing())}
              missingReason={host.state().error ?? ""}
              working={working()}
              activeCard={activeCard()}
              installedCount={installedHere().length}
              total={total()}
              installed={installed}
              installedHere={(id) => installedHere().includes(id)}
              selected={(id) => !unchecked().includes(id)}
              onToggle={(id) =>
                unchecked.update((ids) =>
                  ids.includes(id)
                    ? ids.filter((entry) => entry !== id)
                    : [...ids, id],
                )
              }
              onRetry={() => {
                retryTick.update((count) => count + 1);
                host.reconnect();
              }}
            />
          </If>
          <If when={step() === 3}>
            <View
              style={{
                paddingHorizontal: space[16],
                paddingVertical: space[24],
                gap: space[4],
              }}
            >
              <Label variant="subtitle" weight={weight.strong}>
                {uiText("yourAgentsAreReady")}
              </Label>
              <Label tone="mutedInk">
                {uiText(
                  already() > 1
                    ? "areInstalledSayHello"
                    : "isInstalledSayHello",
                  {
                    names: listText(
                      cards()
                        .filter((card) => installed(card.id))
                        .map((card) => card.name),
                    ),
                  },
                )}
              </Label>
            </View>
          </If>
        </SmoothScroll>
        <If when={step() === 2 && error()}>
          <View
            style={{
              ...row,
              alignItems: "flex-start",
              flexShrink: 0,
              gap: space[8],
              paddingVertical: space[12],
              paddingHorizontal: space[16],
              borderTopWidth: 1,
              borderColor: c().border,
              backgroundColor: c().selected,
            }}
          >
            <View
              style={{
                width: space[16],
                height: space[20],
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Icon name="warning" size={icon.md} tone="red" />
            </View>
            <Label style={{ flex: 1, minWidth: 0 }}>
              {uiText("installFailed", { message: error() })}
            </Label>
          </View>
        </If>
        <View
          style={{
            ...row,
            flexShrink: 0,
            paddingTop: space[12],
            paddingBottom: props.phone ? space[32] : space[12],
            paddingHorizontal: space[16],
            borderTopWidth: 1,
            borderColor: c().border,
            gap: space[8],
          }}
        >
          <View
            style={{
              ...row,
              gap: space[8],
              flexGrow: 1,
              // Step 2's Previous keeps its width; the count beside it wraps.
              flexShrink: step() === 2 ? 0 : 1,
              flexBasis: step() === 2 ? "auto" : 0,
            }}
          >
            <If when={step() === 2}>
              <Button
                label={uiText("previousStep")}
                icon="back"
                disabled={working()}
                size={props.phone ? phoneButton : undefined}
                onPress={() => step.update((value) => value - 1)}
                style={{
                  ...footerButton(working()),
                  paddingLeft: space[8],
                  paddingRight: space[12],
                }}
              />
            </If>
            <If when={step() === 0 || (step() === 1 && !chosenModel())}>
              <Label variant="small" tone="muted">
                {step() === 0
                  ? uiText("youCanChangeAnyOfThis")
                  : uiText("addASourceToContinue")}
              </Label>
            </If>
          </View>
          <View style={{ ...row, flexShrink: 1, gap: space[12] }}>
            <If when={showCount()}>
              <Label
                variant="small"
                tone="muted"
                style={{ flexShrink: 1, textAlign: "right" }}
              >
                {step() === 2 && !working()
                  ? uiText("toInstall", {
                      length: selected().length,
                      value2: already()
                        ? uiText("alreadyInstalled", { length: already() })
                        : "",
                    })
                  : [
                      uiText("ofInstalled", {
                        length: installedHere().length,
                        total: total(),
                      }),
                      installEta(),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
              </Label>
            </If>
            <If when={step() === 0}>
              <Button
                label={uiText("getStarted")}
                tone="primary"
                size={props.phone ? phoneButton : undefined}
                onPress={() => step.set(1)}
                style={footerButton()}
              />
            </If>
            <If when={step() === 1}>
              <Button
                label={uiText("nextStep")}
                tone="primary"
                size={props.phone ? phoneButton : undefined}
                disabled={!chosenModel()}
                onPress={() => step.set(2)}
                style={footerButton(!chosenModel())}
              />
            </If>
            <If when={step() === 2}>
              <Button
                label={
                  working()
                    ? uiText("installing")
                    : error()
                      ? uiText("retryInstall")
                      : uiText("installAgents")
                }
                tone="primary"
                size={props.phone ? phoneButton : undefined}
                disabled={installBlocked()}
                onPress={() => void install()}
                style={footerButton(installBlocked())}
              />
            </If>
            <If when={step() === 3}>
              <Button
                label={uiText("done")}
                tone="primary"
                size={props.phone ? phoneButton : undefined}
                onPress={props.onClose}
                style={footerButton()}
              />
            </If>
          </View>
        </View>
      </Modal>
      <If when={detail()}>
        <Modal
          title={
            sources().find((source) => source.id === detail())?.name ?? detail()
          }
          phone={props.phone}
          width={dialogWidth.xl}
          height={props.phone ? providerHeight.phone : providerHeight.other}
          hideHeader
          onClose={() => detail.set("")}
        >
          <ProviderDetail
            id={detail()}
            phone={props.phone}
            onClose={() => detail.set("")}
          />
        </Modal>
      </If>
      <If when={adding()}>
        <AddSource phone={props.phone} onClose={() => adding.set(false)} />
      </If>
    </>
  );
}
