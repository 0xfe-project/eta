import type { ProvidersView } from "@eta/client-contracts";
import type { SourceChoice } from "./models";
import { Image, Scroll, signal, View } from "nsh";
import photo from "./assets/onboard.jpg";
import { follow, useHost } from "./host";
import { uiText } from "./locale";
import { ModelSelect, ModelSources, useModels } from "./models";
import { ProviderEditor } from "./settings";
import {
  Button,
  Caption,
  colors,
  fill,
  grow,
  Icon,
  Label,
  Modal,
  row,
} from "./ui";

interface Persona {
  id: string;
  name: string;
  description: string;
}

export function Onboard(props: { phone: boolean; onClose: () => void }) {
  const host = useHost();
  const c = colors();
  const step = signal(0);
  const adding = signal(false);
  const custom = signal<SourceChoice | undefined>(undefined);
  const model = signal("");
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
  const cards = () => host.list<Persona>("personas", "cards");
  const installed = (id: string) =>
    installedHere().includes(id) ||
    host.people().some((agent) => agent.persona === id);
  const selected = () =>
    cards().filter(
      (card) => !installed(card.id) && !unchecked().includes(card.id),
    );
  const chosenModel = () =>
    models().some((entry) => entry.id === model()) ? model() : models()[0]?.id;
  function dialogHeight() {
    if (props.phone) return "90%";
    if (step() === 0) return 527;
    if (step() === 1) return models().length ? 330 : 270;
    if (step() === 3) return 227;
    if (cardsMissing()) return 392;
    if (!loadingCards() && !cards().length) return 328;
    return error() ? 552 : 510;
  }
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
        width={640}
        height={dialogHeight()}
        onClose={props.onClose}
        dismissible={!working()}
      >
        <If when={step() > 0}>
          <View
            style={{
              ...row,
              height: 40,
              paddingHorizontal: 16,
              gap: 8,
              borderBottomWidth: 1,
              borderColor: c().border,
            }}
          >
            <If when={step() < 3} else={<Icon name="check" size={12} />}>
              <Caption text={`${step()}/2`} />
            </If>
            <Label size={12} weight={600} style={{ flex: 1 }}>
              {step() === 1
                ? uiText("connectAModel")
                : step() === 2
                  ? uiText("installAgents")
                  : uiText("complete")}
            </Label>
            <If when={step() < 3}>
              <Label size={12} tone="muted">
                {step() === 1
                  ? uiText("nextInstallAgents")
                  : uiText("lastStep")}
              </Label>
            </If>
            <Each of={[1, 2]}>
              {(num) => (
                <View
                  style={{
                    width: 8,
                    height: 8,
                    backgroundColor:
                      step() === num()
                        ? c().ink
                        : step() > num()
                          ? c().faint
                          : c().border,
                  }}
                />
              )}
            </Each>
          </View>
        </If>
        <Scroll style={grow} scrollbar={false}>
          <If when={step() === 0}>
            <View
              style={{ height: props.phone ? 200 : 272, position: "relative" }}
            >
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
              <Label tone="mutedInk">
                {uiText("twoShortStepsThenYourAgents")}
              </Label>
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
          </If>
          <If when={step() === 1}>
            <View style={{ padding: 16, paddingTop: 24, gap: 8 }}>
              <Label size={16} weight={600}>
                {uiText("whichModelShouldYourAgentsUse")}
              </Label>
              <Label tone="muted">
                {models().length
                  ? uiText("selectAModelFromAConnected")
                  : uiText("aSubscriptionAProviderApiKey")}
              </Label>
              <If when={models().length}>
                <View
                  style={{
                    gap: 6,
                    padding: 10,
                    borderWidth: 1,
                    borderColor: c().border,
                  }}
                >
                  <Caption
                    text={uiText("modelsAvailable", {
                      length: models().length,
                    })}
                  />
                  <ModelSelect
                    value={chosenModel() ?? ""}
                    onChange={model.set}
                  />
                </View>
              </If>
              <Button
                label={uiText("addAModelSource")}
                icon="plus"
                tone={models().length ? "ghost" : "primary"}
                onPress={() => adding.set(true)}
                style={{ alignSelf: "flex-start" }}
              />
            </View>
          </If>
          <If when={step() === 2}>
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
                {working()
                  ? uiText("gettingYourAgentsReady")
                  : uiText("whoWouldYouLikeToWork")}
              </Label>
              <Label tone="mutedInk">
                {working()
                  ? uiText("youllLandInChatAsSoon")
                  : uiText("pickAFewToStart")}
              </Label>
            </View>
            <If when={loadingCards()}>
              <Label tone="muted" style={{ padding: 16 }}>
                {uiText("loadingAgents")}
              </Label>
            </If>
            <If when={cardsMissing()}>
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
            <If when={!(cardsMissing() || loadingCards() || cards().length)}>
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
            <Each of={cards()} key={(card) => card.id}>
              {(card) => {
                const checked = () =>
                  installed(card().id) || !unchecked().includes(card().id);
                return (
                  <View
                    role="checkbox"
                    accessibilityLabel={card().name}
                    accessibilityState={{
                      checked: checked(),
                      disabled: installed(card().id) || working(),
                    }}
                    onPress={() => {
                      if (installed(card().id) || working()) return;
                      unchecked.update((ids) =>
                        ids.includes(card().id)
                          ? ids.filter((id) => id !== card().id)
                          : [...ids, card().id],
                      );
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
                    <View
                      style={{
                        width: 16,
                        height: 16,
                        marginTop: 2,
                        borderWidth: 1,
                        borderColor: checked() ? c().button : c().strong,
                        backgroundColor: checked() ? c().button : c().canvas,
                        opacity: installed(card().id) ? 0.3 : 1,
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <If when={checked()}>
                        <Icon name="check" size={11} tone="buttonInk" />
                      </If>
                    </View>
                    <View style={{ flex: 1, gap: 2 }}>
                      <Label weight={500}>{card().name}</Label>
                      <Label size={12} line={16} tone="muted">
                        {card().description}
                      </Label>
                    </View>
                    <If when={installed(card().id)}>
                      <Label size={12} tone="muted">
                        {uiText("installed")}
                      </Label>
                    </If>
                    <If
                      when={activeCard() === card().id && !installed(card().id)}
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
                              width: `${Math.max(20, (100 * (installedHere().length + 0.5)) / Math.max(1, total()))}%`,
                            }}
                          />
                        </View>
                      </View>
                    </If>
                  </View>
                );
              }}
            </Each>
            <If when={error()}>
              <Label
                size={12}
                line={16}
                tone="red"
                style={{ padding: 14, backgroundColor: c().redFill }}
              >
                {uiText("installFailed")}
                {error()}
              </Label>
            </If>
          </If>
          <If when={step() === 3}>
            <View style={{ padding: 24, gap: 8 }}>
              <Label size={16} weight={600}>
                {uiText("yourAgentsAreReady")}
              </Label>
              <Label tone="muted">
                {cards()
                  .filter((card) => installedHere().includes(card.id))
                  .map((card) => card.name)
                  .join(", ")}
                {installedHere().length ? uiText("areInstalled") : ""}
                {uiText("sayHelloInChat")}
              </Label>
            </View>
          </If>
        </Scroll>
        <View
          style={{
            ...row,
            padding: 12,
            paddingHorizontal: 16,
            borderTopWidth: 1,
            borderColor: c().border,
            gap: 8,
          }}
        >
          <If when={step() === 2}>
            <Button
              label={uiText("previous")}
              icon="back"
              disabled={working()}
              onPress={() => step.update((value) => value - 1)}
            />
          </If>
          <Label size={12} tone="muted" style={{ flex: 1 }}>
            {step() === 0
              ? uiText("youCanChangeAnyOfThis")
              : step() === 2
                ? working()
                  ? uiText("ofInstalled", {
                      length: installedHere().length,
                      total: total(),
                    })
                  : uiText("toInstall", {
                      length: selected().length,
                      value2: installedHere().length
                        ? ` · ${installedHere().length} already installed`
                        : "",
                    })
                : step() === 3
                  ? uiText("ofInstalled", {
                      length: installedHere().length,
                      total: total(),
                    })
                  : chosenModel()
                    ? ""
                    : uiText("addASourceToContinue")}
          </Label>
          <If when={step() === 0}>
            <Button
              label={uiText("getStarted")}
              tone="primary"
              onPress={() => step.set(1)}
            />
          </If>
          <If when={step() === 1}>
            <Button
              label={uiText("continue")}
              tone="primary"
              disabled={!chosenModel()}
              onPress={() => step.set(2)}
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
              disabled={
                working() ||
                !chosenModel() ||
                !selected().length ||
                Boolean(cardsMissing())
              }
              onPress={() => void install()}
            />
          </If>
          <If when={step() === 3}>
            <Button
              label={uiText("done")}
              tone="primary"
              onPress={props.onClose}
            />
          </If>
        </View>
      </Modal>
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
