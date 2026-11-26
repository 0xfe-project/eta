import type {
  LlmAccounts,
  LlmConnector,
  LlmLogin,
  LlmModel,
  ProviderDiscoverResult,
  ProviderKind,
  ProvidersView,
} from "@eta/client-contracts";
import type { JSX } from "nsh";
import type { SourcePreset } from "./add-source-model";
import { modelSource } from "@eta/client-contracts";
import { cleanup, effect, openUrl, signal, untracked, View } from "nsh";
import {
  ActionItem,
  ActionMenu,
  Button,
  colors,
  dialogWidth,
  Field,
  Fonts,
  grow,
  Header,
  Label,
  Modal,
  monoFontFamily,
  row,
  SmoothScroll,
} from "../../../components";
import { CheckControl } from "../../../components/check-control";
import { CloseButton } from "../../../components/navigation-buttons";
import { dotSize } from "../../../components/status-dot";
import {
  border,
  control,
  icon,
  space,
  weight,
} from "../../../components/tokens";
import { uiText } from "../../../i18n";
import { useHost } from "../../../services/host";
import { CopyButton } from "../../../ui";
import { EntityRow, LetterBox, SectionHeader } from "../section";
import {
  abilityTags,
  connectorHint,
  connectorKeyUrl,
  discoveryErrorText,
  endpointName,
  formatContext,
  keyLinkText,
  keyNote,
  llmProblemText,
  presetName,
  protocolName,
  recommended,
  saveErrorText,
  SOURCE_GROUPS,
  sourcePresets,
  uniqueId,
  unsupportedReason,
  wireErrorText,
} from "./add-source-model";
import { logoKey, useSourceLogos } from "./logos";

/** The dialog: a sheet's height on phones, its height elsewhere at most, and a step's least. */
const phoneSheetHeight = 712;
const dialogMaxHeight = "92%";
const stepMinHeight = 200;
/** The step bar, a preset group's heading on phones. */
const stepsHeight = 36;
const phoneGroupRow = 20;
/** The protocol menu, a model's state column, the model search. */
const protocolWidth = 224;
const stateWidth = 96;
const searchWidth = 240;

// Adding a model source in three steps: pick where the models come from,
// connect to it (a key, a sign-in, an address), pick the models. Connecting lists the models
// once (getting the list is what says the connection works); a subscription brings its models
// with the sign-in, so its last step only shows them.

interface Listing extends ProviderDiscoverResult {
  /** The connection the list was fetched with: what the saved provider is. */
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string;
}

interface LoginResult {
  login: LlmLogin;
}

const DISCOVER_TIMEOUT_MS = 60_000;
const POLL_MS = 1500;

export function AddSource(props: {
  phone: boolean;
  /** Opens on this preset's connect step (the empty list's way to Eta Token Plan). */
  initialPreset?: string;
  onClose: () => void;
}) {
  const host = useHost();
  const c = colors();
  const connectors = () =>
    host.section<LlmAccounts>("llm", "accounts")?.connectors ?? [];
  const found = sourcePresets().find(
    (entry) => entry.id === props.initialPreset,
  );
  const initial =
    found === undefined || "connector" in found ? undefined : found;
  const step = signal(initial === undefined ? 0 : 1);
  const preset = signal<SourcePreset | undefined>(initial);
  const baseUrl = signal(initial?.baseUrl ?? "");
  const kind = signal<ProviderKind>(initial?.kind ?? "openai-compatible");
  const apiKey = signal("");
  const connecting = signal(false);
  const error = signal<string | undefined>(undefined);
  const listing = signal<Listing | undefined>(undefined);
  const selected = signal<ReadonlySet<string>>(new Set());
  const saving = signal(false);

  const connector = (): LlmConnector | undefined => {
    const current = preset();
    return current !== undefined && "connector" in current
      ? connectors().find((candidate) => candidate.id === current.connector)
      : undefined;
  };
  const custom = () => {
    const current = preset();
    return current !== undefined && "custom" in current
      ? current.custom
      : undefined;
  };
  const name = () => {
    const current = preset();
    if (current === undefined) return "";
    const own = custom();
    return own === undefined
      ? presetName(current, connectors())
      : endpointName(listing()?.baseUrl ?? baseUrl(), own === "local");
  };
  const keyRequired = () => {
    const current = preset();
    return (
      current !== undefined &&
      !("connector" in current) &&
      custom() === undefined
    );
  };
  const title = () =>
    step() === 0 || preset() === undefined ? uiText("addModelSource") : name();

  function pick(next: SourcePreset) {
    preset.set(next);
    baseUrl.set("connector" in next ? "" : next.baseUrl);
    kind.set("connector" in next ? "openai-compatible" : next.kind);
    apiKey.set("");
    error.set(undefined);
    listing.set(undefined);
    step.set(1);
  }

  async function connect() {
    const current = preset();
    if (current === undefined || "connector" in current || connecting()) return;
    if (keyRequired() && apiKey().trim().length === 0) return;
    if (baseUrl().trim().length === 0) return;
    connecting.set(true);
    error.set(undefined);
    const key = apiKey().trim();
    const url = baseUrl().trim();
    const source = kind();
    try {
      const result = await host.call<ProviderDiscoverResult>(
        "providers",
        "discover",
        {
          kind: source,
          baseUrl: url,
          ...(key.length > 0 ? { apiKey: key } : {}),
        },
        { timeoutMs: DISCOVER_TIMEOUT_MS },
      );
      listing.set({ ...result, kind: source, baseUrl: url, apiKey: key });
      selected.set(new Set(recommended(result.models, custom() !== undefined)));
      step.set(2);
    } catch (cause) {
      error.set(discoveryErrorText(cause));
    } finally {
      connecting.set(false);
    }
  }

  async function finish() {
    const list = listing();
    const config = host.section<ProvidersView>("providers", "config");
    if (list === undefined || config === undefined) {
      props.onClose();
      return;
    }
    if (saving() || selected().size === 0) return;
    saving.set(true);
    error.set(undefined);
    const label = name();
    const id = uniqueId(
      label,
      config.providers.map((provider) => provider.id),
    );
    try {
      await host.call("providers", "save", {
        revision: config.revision,
        provider: {
          id,
          name: label,
          kind: list.kind,
          baseUrl: list.baseUrl,
          ...(list.apiKey.length > 0 ? { apiKey: list.apiKey } : {}),
          models: list.models.filter((model) => selected().has(model.id)),
        },
      });
      // The list was the check; recording it is one more look with the saved key.
      void host.call("providers", "check", { id }).catch(() => undefined);
      props.onClose();
    } catch (cause) {
      // A config that moved under the dialog is read again, so the next Done writes on top of it.
      if (cause instanceof Error && cause.message === "config_changed")
        void host.call("providers", "reload").catch(() => undefined);
      error.set(saveErrorText(cause));
    } finally {
      saving.set(false);
    }
  }

  function back() {
    error.set(undefined);
    step.set(step() - 1);
  }

  const busy = () => connecting() || saving();
  // The gateway key form's submit, pressed by the footer's Connect.
  let gatewaySubmit: (() => void) | undefined;
  const showBack = () => step() > 0 && !(step() === 2 && connector());

  return (
    <Modal
      title={title()}
      width={dialogWidth.lg}
      height={props.phone ? phoneSheetHeight : undefined}
      phone={props.phone}
      sheet={props.phone}
      plainSheetHeader={props.phone}
      hideHeader={!props.phone}
      overPhoneNavigation
      blurBackdrop={false}
      dismissible={!busy()}
      panelStyle={props.phone ? undefined : { maxHeight: dialogMaxHeight }}
      onClose={props.onClose}
    >
      <If when={!props.phone}>
        {/* The design's dialog header: 16/400/24 title at 16, a bare 16px X ending 12 from the edge. */}
        <Header
          title={title()}
          layout="desktop"
          dialog
          inset={space[16]}
          end={space[12]}
        >
          <View style={grow} />
          <CloseButton
            size={control.sm}
            iconSize={icon.md}
            style={{ paddingHorizontal: 0 }}
            disabled={busy()}
            onPress={props.onClose}
          />
        </Header>
      </If>
      <If
        when={props.phone}
        else={
          <SectionHeader
            title={
              step() === 0
                ? uiText("sourceStepSource")
                : step() === 1
                  ? uiText("sourceStepConnect")
                  : uiText("sourceStepModels")
            }
            count={uiText("sourceStep", { step: step() + 1 })}
            description={
              step() === 0
                ? uiText("pickWhereTheModelsComeFrom")
                : step() === 1
                  ? connector()?.flow === "oauth_device"
                    ? uiText("addSourceSignInHint")
                    : uiText("addSourceConnectHint")
                  : connector()
                    ? uiText("addSourceAccountHint")
                    : uiText("addSourceModelsHint")
            }
          />
        }
      >
        <SourceSteps step={step()} />
      </If>
      {/* One scroll per step, so a step opens at its top whatever the last one was scrolled to. */}
      <Each of={[step()]} key={(current) => String(current)}>
        {() => (
          <SmoothScroll
            style={
              props.phone ? grow : { flexShrink: 1, minHeight: stepMinHeight }
            }
          >
            <If when={step() === 0 || preset() === undefined}>
              <PresetList phone={props.phone} onPick={pick} />
            </If>
            <If when={step() === 1 ? connector() : undefined}>
              {(account) => (
                <If
                  when={account().flow === "api_key"}
                  else={
                    <DeviceLogin
                      connector={account()}
                      onDone={() => step.set(2)}
                    />
                  }
                >
                  <GatewayKeyForm
                    connector={account()}
                    phone={props.phone}
                    onPendingChange={connecting.set}
                    bind={(submit) => {
                      gatewaySubmit = submit;
                    }}
                    onDone={() => step.set(2)}
                  />
                </If>
              )}
            </If>
            <If when={step() === 1 && preset() && !connector()}>
              <View
                style={{
                  paddingHorizontal: space[16],
                  paddingVertical: space[16],
                  gap: space[12],
                }}
              >
                <If when={custom() !== undefined}>
                  <FieldBlock label={uiText("addSourceUrl")}>
                    <Field
                      label={uiText("addSourceUrl")}
                      value={baseUrl()}
                      placeholder="https://…/v1"
                      onChange={(value) => {
                        baseUrl.set(value);
                        error.set(undefined);
                      }}
                      onSubmit={() => void connect()}
                      style={{ fontFamily: monoFontFamily(Fonts()()) }}
                    />
                  </FieldBlock>
                </If>
                <If when={custom() === "endpoint"}>
                  <FieldBlock label={uiText("addSourceProtocol")}>
                    <View style={{ ...row, width: protocolWidth }}>
                      <ActionMenu
                        label={uiText("addSourceProtocol")}
                        value={protocolName(kind())}
                        triggerStyle={{ width: protocolWidth }}
                      >
                        <Each
                          of={
                            ["openai-compatible", "openai-responses"] as const
                          }
                        >
                          {(choice) => (
                            <ActionItem
                              label={protocolName(choice())}
                              checked={kind() === choice()}
                              onSelect={() => kind.set(choice())}
                            />
                          )}
                        </Each>
                      </ActionMenu>
                    </View>
                  </FieldBlock>
                </If>
                <FieldBlock
                  label={
                    custom() === undefined
                      ? uiText("addSourceKeyLabel", { name: name() })
                      : uiText("addSourceKeyOptional")
                  }
                >
                  <Field
                    label={
                      custom() === undefined
                        ? uiText("addSourceKeyLabel", { name: name() })
                        : uiText("addSourceKeyOptional")
                    }
                    value={apiKey()}
                    masked
                    onChange={(value) => {
                      apiKey.set(value);
                      error.set(undefined);
                    }}
                    onSubmit={() => void connect()}
                    style={error() ? { borderColor: c().ink } : undefined}
                  />
                  <If when={modelSource(kind())?.keysUrl}>
                    {(url) => (
                      <LinkText
                        text={keyLinkText(kind())}
                        onPress={() => void host.action(() => openUrl(url()))}
                      />
                    )}
                  </If>
                  <If when={keyNote(kind())}>
                    {(note) => (
                      <Label variant="small" tone="muted">
                        {note()}
                      </Label>
                    )}
                  </If>
                </FieldBlock>
                <If when={error()}>{(text) => <Alert text={text()} />}</If>
              </View>
            </If>
            <If when={step() === 2 ? connector() : undefined}>
              {(account) => <AccountReady connector={account()} />}
            </If>
            <If when={step() === 2 && !connector() ? listing() : undefined}>
              {(list) => (
                <ModelPicker
                  listing={list()}
                  phone={props.phone}
                  selected={selected()}
                  onToggle={(id, on) => {
                    const next = new Set(selected());
                    if (on) next.add(id);
                    else next.delete(id);
                    selected.set(next);
                  }}
                />
              )}
            </If>
            <If when={step() === 2 ? error() : undefined}>
              {(text) => (
                <View
                  style={{
                    paddingHorizontal: space[16],
                    paddingBottom: space[12],
                  }}
                >
                  <Alert text={text()} />
                </View>
              )}
            </If>
          </SmoothScroll>
        )}
      </Each>
      <View
        style={{
          ...row,
          flexShrink: 0,
          justifyContent: "space-between",
          gap: space[8],
          paddingHorizontal: space[16],
          paddingTop: props.phone ? space[8] : space[12],
          paddingBottom: props.phone ? space[8] : space[12],
          borderTopWidth: 1,
          borderColor: c().border,
        }}
      >
        <Button
          label={uiText("cancel")}
          tone="ghost"
          size={props.phone ? control.lg : undefined}
          disabled={busy()}
          onPress={props.onClose}
        />
        <View style={{ ...row, gap: space[8] }}>
          <If when={showBack()}>
            <Button
              label={uiText("addSourceBack")}
              size={props.phone ? control.lg : undefined}
              style={{ paddingHorizontal: props.phone ? space[16] : space[12] }}
              disabled={busy()}
              onPress={back}
            />
          </If>
          <If when={step() === 1 && !connector()}>
            <Button
              label={uiText("addSourceConnect")}
              tone="primary"
              size={props.phone ? control.lg : undefined}
              style={{ paddingHorizontal: props.phone ? space[16] : space[12] }}
              disabled={
                (keyRequired() && apiKey().trim().length === 0) ||
                baseUrl().trim().length === 0
              }
              busy={connecting()}
              onPress={() => void connect()}
            />
          </If>
          <If when={step() === 1 && connector()?.flow === "api_key"}>
            <Button
              label={uiText("addSourceConnect")}
              tone="primary"
              size={props.phone ? control.lg : undefined}
              style={{ paddingHorizontal: props.phone ? space[16] : space[12] }}
              busy={connecting()}
              onPress={() => gatewaySubmit?.()}
            />
          </If>
          <If when={step() === 2}>
            <Button
              label={uiText("addSourceDone")}
              tone="primary"
              size={props.phone ? control.lg : undefined}
              style={{ paddingHorizontal: props.phone ? space[16] : space[12] }}
              disabled={!connector() && selected().size === 0}
              busy={!connector() && saving()}
              onPress={() => (connector() ? props.onClose() : void finish())}
            />
          </If>
        </View>
      </View>
    </Modal>
  );
}

/** The phone's steps of adding a source, the current one underlined. */
function SourceSteps(props: { step: number }) {
  const c = colors();
  const steps = () => [
    uiText("sourceStepSource"),
    uiText("sourceStepConnect"),
    uiText("sourceStepModels"),
  ];
  return (
    <View
      style={{
        ...row,
        height: stepsHeight,
        flexShrink: 0,
        alignItems: "stretch",
        borderBottomWidth: 1,
        borderColor: c().border,
      }}
    >
      <Each of={steps()}>
        {(label, index) => (
          <View
            style={{
              flex: 1,
              alignItems: "center",
              justifyContent: "center",
              borderBottomWidth: index() === props.step ? border.thick : 0,
              borderColor: c().ink,
            }}
          >
            <Label
              variant="small"
              weight={index() === props.step ? weight.strong : weight.regular}
              tone={index() === props.step ? "ink" : "mutedInk"}
            >
              {index() < props.step
                ? `✓ ${label()}`
                : `${index() + 1} ${label()}`}
            </Label>
          </View>
        )}
      </Each>
    </View>
  );
}

/** Every source there is, grouped: Eta first, then the groups. */
function PresetList(props: {
  phone: boolean;
  onPick: (preset: SourcePreset) => void;
}) {
  const host = useHost();
  const c = colors();
  const logo = useSourceLogos();
  const connectors = () =>
    host.section<LlmAccounts>("llm", "accounts")?.connectors ?? [];
  const offered = () =>
    sourcePresets().filter(
      (preset) =>
        !("connector" in preset) ||
        connectors().some((connector) => connector.id === preset.connector),
    );
  const groupTitle = (group: (typeof SOURCE_GROUPS)[number]) =>
    group === "subscription"
      ? uiText("subscriptions")
      : group === "key"
        ? uiText("providerApiKeys")
        : uiText("custom");
  const presetMeta = (preset: SourcePreset) => {
    if ("connector" in preset) return undefined;
    if (preset.custom === "local") return uiText("localModelsHint");
    if (preset.custom === "endpoint" && !props.phone)
      return uiText("openaiCompatibleHint");
    return undefined;
  };
  const logoOf = (preset: SourcePreset) =>
    "connector" in preset
      ? logo(logoKey.connector(preset.connector))
      : preset.custom === "local"
        ? logo(logoKey.local)
        : preset.custom === undefined
          ? logo(logoKey.kind(preset.kind))
          : undefined;
  return (
    <>
      <Each
        of={offered().filter((preset) => preset.group === "recommended")}
        key={(preset) => preset.id}
      >
        {(preset) => (
          <EntityRow
            title={presetName(preset(), connectors())}
            leading={
              <LetterBox
                name={presetName(preset(), connectors())}
                logo={logoOf(preset())}
              />
            }
            stacked={props.phone}
            meta={uiText("etasOwnGatewayOneKeyFor")}
            status={{ label: uiText("sourceRecommended"), color: c().blue }}
            caret={!props.phone}
            onPress={() => props.onPick(preset())}
          />
        )}
      </Each>
      <Each of={[...SOURCE_GROUPS]}>
        {(group) => (
          <If when={offered().some((preset) => preset.group === group())}>
            <SectionHeader
              title={groupTitle(group())}
              rowHeight={props.phone ? phoneGroupRow : undefined}
            />
            <Each
              of={offered().filter((preset) => preset.group === group())}
              key={(preset) => preset.id}
            >
              {(preset) => (
                <EntityRow
                  title={presetName(preset(), connectors())}
                  leading={
                    <LetterBox
                      name={presetName(preset(), connectors())}
                      logo={logoOf(preset())}
                    />
                  }
                  meta={presetMeta(preset())}
                  lane={false}
                  caret={!props.phone}
                  onPress={() => props.onPick(preset())}
                />
              )}
            </Each>
          </If>
        )}
      </Each>
    </>
  );
}

function FieldBlock(props: { label: string; children?: JSX.Element }) {
  return (
    <View style={{ gap: space[4] }}>
      <Label variant="small" tone="muted">
        {props.label}
      </Label>
      {props.children}
    </View>
  );
}

function LinkText(props: { text: string; onPress: () => void }) {
  return (
    <View
      role="link"
      accessibilityLabel={props.text}
      onPress={props.onPress}
      style={{ alignSelf: "flex-start", cursor: "pointer" }}
    >
      <Label
        variant="small"
        tone="muted"
        style={{ textDecorationLine: "underline" }}
      >
        {props.text}
      </Label>
    </View>
  );
}

/** A failure, as the design draws one: a small red mark and the text in ink. */
function Alert(props: { text: string }) {
  const c = colors();
  return (
    <View
      role="alert"
      style={{ ...row, alignItems: "flex-start", gap: space[4] }}
    >
      <View
        style={{
          width: dotSize,
          height: dotSize,
          marginTop: space[4],
          flexShrink: 0,
          backgroundColor: c().red,
        }}
      />
      <Label variant="small" style={{ flex: 1, minWidth: 0 }}>
        {props.text}
      </Label>
    </View>
  );
}

/**
 * Device-code sign-in: the code, the page to enter it on, and a wait that ends by itself. Started
 * once when shown; leaving while it waits cancels it.
 */
function DeviceLogin(props: { connector: LlmConnector; onDone: () => void }) {
  const host = useHost();
  const c = colors();
  const login = signal<LlmLogin | undefined>(undefined);
  const failure = signal<string | undefined>(undefined);
  const starting = signal(false);
  const now = signal(Date.now());
  let alive = true;

  async function start() {
    starting.set(true);
    failure.set(undefined);
    login.set(undefined);
    try {
      const result = await host.call<LoginResult>("llm", "loginStart", {
        connector: props.connector.id,
      });
      if (!alive) {
        void host
          .call("llm", "loginCancel", { id: result.login.id })
          .catch(() => undefined);
        return;
      }
      login.set(result.login);
    } catch (cause) {
      if (alive) failure.set(wireErrorText(cause));
    } finally {
      starting.set(false);
    }
  }
  untracked(() => void start());

  // Poll while it waits; a status that is not pending ends it.
  effect(() => {
    const current = login();
    if (current?.status !== "pending") return;
    const id = current.id;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await host.call<LoginResult>("llm", "loginPoll", { id });
        if (!active) return;
        login.set(result.login);
        if (result.login.status !== "pending") return;
      } catch (cause) {
        if (!active) return;
        failure.set(wireErrorText(cause));
        return;
      }
      timer = setTimeout(() => void poll(), POLL_MS);
    };
    timer = setTimeout(() => void poll(), POLL_MS);
    const clock = setInterval(() => now.set(Date.now()), 1000);
    cleanup(() => {
      active = false;
      clearTimeout(timer);
      clearInterval(clock);
    });
  });
  effect(() => {
    if (login()?.status === "succeeded") untracked(() => props.onDone());
  });
  // Leaving while it waits cancels it.
  cleanup(() => {
    alive = false;
    const current = untracked(login);
    if (current?.status === "pending")
      void host.call("llm", "loginCancel", { id: current.id }).catch(() => {});
  });

  const seconds = () => {
    const current = login();
    return current
      ? Math.max(
          0,
          Math.round((new Date(current.expiresAt).getTime() - now()) / 1000),
        )
      : 0;
  };
  const error = () => {
    const problem = failure();
    if (problem) return problem;
    const current = login();
    if (
      !current ||
      current.status === "pending" ||
      current.status === "succeeded"
    )
      return undefined;
    return current.error
      ? llmProblemText(current.error)
      : uiText("addSourceLoginFailed");
  };
  const hint = () => connectorHint(props.connector.id);
  return (
    <View
      style={{
        paddingHorizontal: space[16],
        paddingVertical: space[16],
        gap: space[12],
      }}
    >
      <Label variant="small" tone="muted">
        {uiText("addSourceLoginInstructions")}
      </Label>
      <If when={error() ? undefined : login()?.userCode}>
        {(code) => (
          <View
            style={{
              ...row,
              justifyContent: "space-between",
              gap: space[8],
              paddingHorizontal: space[12],
              paddingVertical: space[8],
              backgroundColor: c().surface,
              borderWidth: 1,
              borderColor: c().border,
            }}
          >
            <View
              accessibilityLabel={uiText("addSourceCodeLabel", {
                code: code(),
              })}
            >
              <Label
                tracking="caps"
                variant="subtitle"
                weight={weight.strong}
                style={{
                  fontFamily: monoFontFamily(Fonts()()),
                }}
              >
                {code()}
              </Label>
            </View>
            <CopyButton label={uiText("addSourceCopyCode")} value={code} />
          </View>
        )}
      </If>
      <If
        when={error()}
        else={
          <View style={{ ...row, flexWrap: "wrap", gap: space[12] }}>
            <Button
              label={uiText("addSourceOpenAuthorization")}
              end="external"
              tone="primary"
              disabled={!login()?.url}
              onPress={() => {
                const url = login()?.url;
                if (url) void host.action(() => openUrl(url));
              }}
            />
            <View
              android={{ accessibilityLiveRegion: "polite" }}
              style={{ ...row, gap: space[4], flexShrink: 1 }}
            >
              <View
                style={{
                  width: dotSize,
                  height: dotSize,
                  backgroundColor: c().blue,
                }}
              />
              <Label variant="small" tone="mutedInk">
                {login()
                  ? uiText("addSourceWaiting", {
                      minutes: Math.floor(seconds() / 60),
                      seconds: String(seconds() % 60).padStart(2, "0"),
                    })
                  : uiText("addSourceLoadingCode")}
              </Label>
            </View>
          </View>
        }
      >
        {(text) => (
          <View style={{ ...row, flexWrap: "wrap", gap: space[12] }}>
            <Alert text={text()} />
            <Button
              label={uiText("addSourceRetry")}
              busy={starting()}
              onPress={() => void start()}
            />
          </View>
        )}
      </If>
      <If when={hint()}>
        {(text) => (
          <Label variant="small" tone="muted">
            {text()}
          </Label>
        )}
      </If>
    </View>
  );
}

/**
 * A key the gateway holds (Google AI Studio): checked with the provider before it is kept. Each
 * attempt is a login of its own, with the key as its input.
 */
function GatewayKeyForm(props: {
  connector: LlmConnector;
  phone: boolean;
  onPendingChange: (pending: boolean) => void;
  /** Hands the form's submit to the footer button that presses it. */
  bind: (submit: (() => void) | undefined) => void;
  onDone: () => void;
}) {
  const host = useHost();
  const c = colors();
  const apiKey = signal("");
  const pending = signal(false);
  const failure = signal<string | undefined>(undefined);
  async function save() {
    const key = apiKey().trim();
    if (!key || pending()) return;
    pending.set(true);
    props.onPendingChange(true);
    failure.set(undefined);
    try {
      const { login } = await host.call<LoginResult>("llm", "loginStart", {
        connector: props.connector.id,
      });
      const { login: done } = await host.call<LoginResult>(
        "llm",
        "loginSubmit",
        { id: login.id, apiKey: key },
      );
      if (done.status === "succeeded") props.onDone();
      else if (done.error) failure.set(llmProblemText(done.error));
    } catch (cause) {
      failure.set(wireErrorText(cause));
    } finally {
      pending.set(false);
      props.onPendingChange(false);
    }
  }
  props.bind(() => void save());
  cleanup(() => props.bind(undefined));
  const keyUrl = () => connectorKeyUrl(props.connector.id);
  const label = () =>
    uiText("addSourceKeyLabel", { name: props.connector.name });
  return (
    <View
      style={{
        paddingHorizontal: space[16],
        paddingVertical: space[16],
        gap: space[12],
      }}
    >
      <FieldBlock label={label()}>
        <Field
          label={label()}
          value={apiKey()}
          masked
          onChange={(value) => {
            apiKey.set(value);
            failure.set(undefined);
          }}
          onSubmit={() => void save()}
          style={failure() ? { borderColor: c().ink } : undefined}
        />
        <If when={keyUrl()}>
          {(url) => (
            <LinkText
              text={connectorHint(props.connector.id) ?? url()}
              onPress={() => void host.action(() => openUrl(url()))}
            />
          )}
        </If>
      </FieldBlock>
      <If when={failure()}>{(text) => <Alert text={text()} />}</If>
    </View>
  );
}

/** The models a gateway account brings: nothing to choose, they come with the sign-in. */
function AccountReady(props: { connector: LlmConnector }) {
  const host = useHost();
  const c = colors();
  const models = () =>
    (host.section<LlmModel[]>("llm", "models") ?? []).filter(
      (model) => model.connector === props.connector.id,
    );
  const cell = { paddingHorizontal: space[8], paddingVertical: space[8] };
  return (
    <View
      style={{
        paddingHorizontal: space[16],
        paddingVertical: space[16],
        gap: space[8],
      }}
    >
      <View style={{ ...row, gap: space[4] }}>
        <View
          style={{
            width: dotSize,
            height: dotSize,
            backgroundColor: c().green,
          }}
        />
        <Label variant="small">
          {models().length === 1
            ? uiText("addSourceAccountReadyOne", { name: props.connector.name })
            : uiText("addSourceAccountReady", {
                name: props.connector.name,
                count: models().length,
              })}
        </Label>
      </View>
      <If
        when={models().length}
        else={
          <Label variant="small" tone="muted">
            {uiText("addSourceNoModels")}
          </Label>
        }
      >
        <View style={{ borderWidth: 1, borderColor: c().border }}>
          <View
            style={{
              ...row,
              ...cell,
              borderBottomWidth: 1,
              borderColor: c().border,
            }}
          >
            <Label variant="small" tone="faint" style={{ flex: 1 }}>
              {uiText("addSourceModelColumn")}
            </Label>
            <Label variant="small" tone="faint" style={{ width: space[64] }}>
              {uiText("addSourceContextColumn")}
            </Label>
            <Label variant="small" tone="faint" style={{ width: stateWidth }}>
              {uiText("addSourceStateColumn")}
            </Label>
          </View>
          <Each of={models()} key={(model) => model.id}>
            {(model) => (
              <View
                style={{
                  ...row,
                  ...cell,
                  alignItems: "flex-start",
                  borderBottomWidth: 1,
                  borderColor: c().border,
                }}
              >
                <Label
                  variant="small"
                  lines={1}
                  style={{ flex: 1, minWidth: 0 }}
                >
                  {model().name}
                </Label>
                <Label
                  variant="small"
                  tone="muted"
                  style={{ width: space[64] }}
                >
                  {formatContext(model().contextWindow)}
                </Label>
                <Label
                  variant="small"
                  tone={model().available ? "muted" : "red"}
                  style={{ width: stateWidth }}
                >
                  {model().available
                    ? uiText("addSourceWorking")
                    : model().reason
                      ? llmProblemText(model().reason!)
                      : uiText("addSourceUnavailable")}
                </Label>
              </View>
            )}
          </Each>
        </View>
      </If>
    </View>
  );
}

function ModelPicker(props: {
  listing: Listing;
  phone: boolean;
  selected: ReadonlySet<string>;
  onToggle: (id: string, on: boolean) => void;
}) {
  const c = colors();
  const search = signal("");
  const matches = (model: { id: string; name?: string | undefined }) =>
    `${model.id} ${model.name ?? ""}`
      .toLowerCase()
      .includes(search().trim().toLowerCase());
  const models = () => props.listing.models.filter(matches);
  const unsupported = () => (props.listing.unsupported ?? []).filter(matches);
  const rowStyle = {
    ...row,
    gap: space[8],
    paddingHorizontal: space[8],
    paddingVertical: space[8],
    borderBottomWidth: 1,
    borderColor: c().border,
  };
  return (
    <View
      style={{
        paddingHorizontal: space[16],
        paddingVertical: space[16],
        gap: space[8],
      }}
    >
      <If
        when={
          props.listing.models.length > 0 ||
          (props.listing.unsupported?.length ?? 0) > 0
        }
        else={
          <Label variant="small" tone="muted">
            {uiText("addSourceNoModels")}
          </Label>
        }
      >
        <View style={{ ...row, gap: space[8] }}>
          <Field
            label={uiText("addSourceSearch")}
            placeholder={uiText("addSourceSearch")}
            value={search()}
            onChange={search.set}
            style={{
              width: props.phone ? undefined : searchWidth,
              flex: props.phone ? 1 : undefined,
            }}
          />
          <View style={grow} />
          <View>
            <Label variant="small" tone="muted">
              {uiText("addSourceSelected", { count: props.selected.size })}
            </Label>
          </View>
        </View>
        <View
          accessibilityLabel={uiText("sourceStepModels")}
          style={{
            borderWidth: 1,
            borderColor: c().border,
            borderBottomWidth: 0,
          }}
        >
          <Each of={models()} key={(model) => model.id}>
            {(model) => (
              <CheckControl
                label={model().name ?? model().id}
                checked={props.selected.has(model().id)}
                size={icon.md}
                onChange={(on) => props.onToggle(model().id, on)}
                style={rowStyle}
              >
                <View style={{ ...row, flex: 1, minWidth: 0, gap: space[4] }}>
                  <Label variant="small" lines={1} style={{ flexShrink: 1 }}>
                    {model().name ?? model().id}
                  </Label>
                  <If
                    when={
                      !props.phone &&
                      (model().name ?? model().id) !== model().id
                    }
                  >
                    <Label
                      variant="small"
                      tone="faint"
                      lines={1}
                      style={{
                        fontFamily: monoFontFamily(Fonts()()),
                        flexShrink: 1,
                      }}
                    >
                      {model().id}
                    </Label>
                  </If>
                </View>
                <If when={model().deprecated}>
                  <Tag text={uiText("addSourceDeprecated")} />
                </If>
                <If when={!props.phone}>
                  <Each of={abilityTags(model())}>
                    {(tag) => <Tag text={tag()} />}
                  </Each>
                </If>
                <Label
                  variant="small"
                  tone="muted"
                  style={{
                    width: space[48],
                    textAlign: "right",
                    flexShrink: 0,
                  }}
                >
                  {formatContext(model().contextWindow)}
                </Label>
              </CheckControl>
            )}
          </Each>
          <Each of={unsupported()} key={(model) => model.id}>
            {(model) => (
              <CheckControl
                label={model().name ?? model().id}
                checked={false}
                disabled
                size={icon.md}
                onChange={() => {}}
                style={rowStyle}
              >
                <Label
                  variant="small"
                  tone="faint"
                  lines={1}
                  style={{ flex: 1, minWidth: 0 }}
                >
                  {model().name ?? model().id}
                </Label>
                <Label variant="small" tone="faint" style={{ flexShrink: 1 }}>
                  {unsupportedReason(model())}
                </Label>
              </CheckControl>
            )}
          </Each>
          <If when={models().length === 0 && unsupported().length === 0}>
            <View style={rowStyle}>
              <Label variant="small" tone="muted">
                {uiText("addSourceNoMatches")}
              </Label>
            </View>
          </If>
        </View>
      </If>
    </View>
  );
}

function Tag(props: { text: string }) {
  const c = colors();
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: c().border,
        paddingHorizontal: space[4],
        flexShrink: 0,
      }}
    >
      <Label variant="small" tone="mutedInk">
        {props.text}
      </Label>
    </View>
  );
}
