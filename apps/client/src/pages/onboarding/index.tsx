import type { ProvidersView } from "@eta/client-contracts";
import type { SourceChoice } from "../settings/models/sources";
import type { Persona } from "./persona-step";
import { Scroll, signal, View } from "nsh";
import {
  Button,
  colors,
  grow,
  Header,
  Icon,
  Label,
  Modal,
  row,
} from "../../components";
import { useModels } from "../../components/model-select";
import { StatusDot } from "../../components/status-dot";
import { uiText } from "../../i18n";
import { follow, useHost } from "../../services/host";
import { ProviderDetail } from "../settings/models/provider-detail";
import { ProviderEditor } from "../settings/models/provider-editor";
import { ModelSources } from "../settings/models/sources";
import { PersonaStep } from "./persona-step";
import { WelcomeStep } from "./welcome";

// Footer buttons: 12pt from the edge to the label (the primary's 1pt border
// counts), 8 before a leading icon, a 6pt gap, and half opacity when disabled.
const footerButton = (disabled = false) => ({
  paddingHorizontal: 11,
  gap: 6,
  opacity: disabled ? 0.5 : 1,
});
// On a phone the footer's buttons are 36pt tall, as is step 1's first Add source.
const phoneButton = 36;

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
  const custom = signal<SourceChoice | undefined>(undefined);
  const detail = signal("");
  const unchecked = signal<string[]>([]);
  const installedHere = signal<string[]>([]);
  const working = signal(false);
  const activeCard = signal("");
  const error = signal("");
  const total = signal(0);
  const cardsMissing = () =>
    host.state().missing.personas || host.state().status === "reconnecting";
  const loadingCards = () => !host.state().targets.personas && !cardsMissing();
  follow(() => "personas");
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
      }
      step.set(3);
    } catch (cause) {
      error.set(cause instanceof Error ? cause.message : String(cause));
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
        width={640}
        height={props.phone ? "100%" : undefined}
        onClose={props.onClose}
        dismissible={false}
        hideHeader
      >
        <Header
          title={uiText("setUpEta")}
          layout="desktop"
          dialog
          inset={16}
          end={12}
          titleLine={24}
        />
        <If when={step() > 0}>
          <View
            style={{
              ...row,
              height: 40,
              flexShrink: 0,
              paddingHorizontal: 16,
              gap: 12,
              borderBottomWidth: 1,
              borderColor: c().border,
            }}
          >
            <View style={{ ...row, gap: 8 }}>
              <If when={step() < 3} else={<Icon name="check" size={12} />}>
                <Label
                  size={10}
                  line={12}
                  tone="muted"
                  style={{ letterSpacing: 0.8 }}
                >
                  {`${step()}/2`}
                </Label>
              </If>
              <Label size={12} line={16} weight={600}>
                {step() === 1
                  ? uiText("connectAModel")
                  : step() === 2
                    ? uiText("installAgents")
                    : uiText("complete")}
              </Label>
            </View>
            <Label
              size={12}
              line={16}
              tone="muted"
              style={{ flex: 1, textAlign: "right" }}
            >
              {step() === 1
                ? uiText("nextInstallAgents")
                : step() === 2
                  ? uiText("lastStep")
                  : ""}
            </Label>
            <View style={{ ...row, gap: 4 }}>
              <Each of={[1, 2]}>
                {(num) => (
                  <If
                    when={step() >= num()}
                    else={
                      <View
                        style={{
                          width: 8,
                          height: 8,
                          borderWidth: 1,
                          borderColor: c().strong,
                        }}
                      />
                    }
                  >
                    <StatusDot
                      color={step() === num() ? c().ink : c().faint}
                      size={8}
                    />
                  </If>
                )}
              </Each>
            </View>
          </View>
        </If>
        <Scroll
          style={props.phone ? grow : { flexShrink: 1, minHeight: 0 }}
          scrollbar={false}
        >
          <If when={step() === 0}>
            <WelcomeStep phone={props.phone} />
          </If>
          <If when={step() === 1}>
            <View style={{ padding: 16, paddingTop: 24, gap: 4 }}>
              <Label size={16} line={24} weight={600}>
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
            <View style={{ paddingHorizontal: 16, paddingBottom: 24, gap: 8 }}>
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
                      gap: 10,
                      paddingVertical: 8,
                      paddingHorizontal: 12,
                      borderWidth: 1,
                      borderColor: c().border,
                      cursor: "pointer",
                    }}
                  >
                    <View
                      style={{
                        width: 24,
                        height: 24,
                        flexShrink: 0,
                        alignItems: "center",
                        justifyContent: "center",
                        borderWidth: 1,
                        borderColor: c().strong,
                      }}
                    >
                      <Icon name="plugins" size={14} />
                    </View>
                    <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                      <Label weight={500}>{source().name ?? source().id}</Label>
                      <Label size={12} line={16} tone="muted">
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
                        width: 80,
                        height: 20,
                        gap: 6,
                        flexShrink: 0,
                      }}
                    >
                      <StatusDot
                        color={source().models.length ? c().green : c().amber}
                      />
                      <Label size={12} line={16} tone="mutedInk">
                        {source().models.length
                          ? uiText("working2")
                          : uiText("needsAttention")}
                      </Label>
                    </View>
                    <View style={{ marginTop: 2 }}>
                      <Icon name="right" size={16} tone="mutedInk" />
                    </View>
                  </View>
                )}
              </Each>
              <Button
                label={uiText("addSource")}
                icon="plus"
                tone={sources().length ? "ghost" : "primary"}
                size={sources().length ? 24 : props.phone ? phoneButton : 28}
                onPress={() => adding.set(true)}
                style={{
                  alignSelf: "flex-start",
                  gap: 6,
                  paddingHorizontal: sources().length ? 0 : 11,
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
            />
          </If>
          <If when={step() === 3}>
            <View
              style={{ paddingHorizontal: 16, paddingVertical: 24, gap: 4 }}
            >
              <Label size={16} line={24} weight={600}>
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
        </Scroll>
        <If when={step() === 2 && error()}>
          <View
            style={{
              ...row,
              alignItems: "flex-start",
              flexShrink: 0,
              gap: 8,
              paddingVertical: 10,
              paddingHorizontal: 16,
              borderTopWidth: 1,
              borderColor: c().border,
              backgroundColor: c().selected,
            }}
          >
            <View
              style={{
                width: 16,
                height: 20,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Icon name="warning" size={14} tone="red" />
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
            paddingTop: 12,
            paddingBottom: props.phone ? 28 : 12,
            paddingHorizontal: 16,
            borderTopWidth: 1,
            borderColor: c().border,
            gap: 8,
          }}
        >
          <View
            style={{
              ...row,
              gap: 8,
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
                  paddingLeft: 8,
                  paddingRight: 12,
                }}
              />
            </If>
            <If when={step() === 0 || (step() === 1 && !chosenModel())}>
              <Label size={12} line={16} tone="muted">
                {step() === 0
                  ? uiText("youCanChangeAnyOfThis")
                  : uiText("addASourceToContinue")}
              </Label>
            </If>
          </View>
          <View style={{ ...row, flexShrink: 1, gap: 12 }}>
            <If when={step() === 2 && loadingCards()}>
              <Label size={12} line={16} tone="muted">
                {uiText("loadingEllipsis")}
              </Label>
            </If>
            <If when={showCount()}>
              <Label
                size={12}
                line={16}
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
                  : uiText("ofInstalled", {
                      length: installedHere().length,
                      total: total(),
                    })}
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
          width={640}
          height={props.phone ? "90%" : 560}
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
        <ModelSources
          phone={props.phone}
          onClose={() => adding.set(false)}
          onCustom={custom.set}
        />
      </If>
      <If when={custom()}>
        <ProviderEditor
          phone={props.phone}
          source={custom()}
          revision={providers()?.revision ?? ""}
          onClose={() => custom.set(undefined)}
        />
      </If>
    </>
  );
}
