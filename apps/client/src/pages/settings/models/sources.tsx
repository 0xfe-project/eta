import type {
  LlmAccounts,
  LlmLogin,
  ProviderKind,
} from "@eta/client-contracts";
import { modelSource } from "@eta/client-contracts";
import { cleanup, Clipboard, effect, openUrl, Scroll, signal, View } from "nsh";
import {
  Button,
  Caption,
  colors,
  Field,
  grow,
  Header,
  Label,
  Modal,
  row,
} from "../../../components";
import { CloseButton } from "../../../components/navigation-buttons";
import { uiText } from "../../../i18n";
import { useHost } from "../../../services/host";
import { EntityRow, LetterBox, SectionHeader } from "../section";

export interface SourceChoice {
  kind: ProviderKind;
  local?: boolean;
}

const keySources: ProviderKind[] = [
  "deepseek",
  "kimi-coding",
  "zai-coding-cn",
  "zai",
  "opencode",
  "opencode-go",
  "commandcode",
];

export function ModelSources(props: {
  phone: boolean;
  onCustom: (source: SourceChoice) => void;
  onClose: () => void;
}) {
  const host = useHost();
  const c = colors();
  const accounts = () => host.section<LlmAccounts>("llm", "accounts");
  const login = signal<LlmLogin | undefined>(undefined);
  const apiKey = signal("");
  const busy = signal(false);
  interface LoginResult {
    login: LlmLogin;
  }
  function accept(next: LlmLogin) {
    login.set(next);
    if (next.status === "succeeded") props.onClose();
  }
  async function start(connector: string) {
    if (busy()) return;
    busy.set(true);
    const result = await host.action(() =>
      host.call<LoginResult>("llm", "loginStart", { connector }),
    );
    busy.set(false);
    if (result) accept(result.login);
  }
  async function submit() {
    const id = login()?.id;
    if (!id || busy() || !apiKey().trim()) return;
    busy.set(true);
    const result = await host.action(() =>
      host.call<LoginResult>("llm", "loginSubmit", {
        id,
        apiKey: apiKey().trim(),
      }),
    );
    busy.set(false);
    if (result) {
      apiKey.set("");
      accept(result.login);
    }
  }
  effect(() => {
    const pending = login();
    if (!pending || pending.status !== "pending" || pending.flow === "api_key")
      return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await host.call<LoginResult>("llm", "loginPoll", {
          id: pending.id,
        });
        if (!active) return;
        if (result.login.status !== "pending") {
          accept(result.login);
          return;
        }
      } catch {
        if (!active) return;
      }
      if (Date.parse(pending.expiresAt) <= Date.now()) {
        login.set({ ...pending, status: "expired" });
        return;
      }
      timer = setTimeout(poll, 2000);
    };
    timer = setTimeout(poll, 2000);
    cleanup(() => {
      active = false;
      clearTimeout(timer);
    });
  });
  function choose(source: SourceChoice) {
    props.onClose();
    props.onCustom(source);
  }
  function close() {
    const pending = login();
    if (pending?.status === "pending")
      void host.call("llm", "loginCancel", { id: pending.id }).catch(() => {});
    props.onClose();
  }
  return (
    <Modal
      title={uiText("addModelSource")}
      width={576}
      height={props.phone ? 712 : login() ? 360 : undefined}
      phone={props.phone}
      sheet={props.phone}
      hideHeader={!props.phone}
      overPhoneNavigation
      blurBackdrop={false}
      dismissible={!busy()}
      onClose={close}
    >
      <If when={!props.phone}>
        {/* The design's dialog header: 16/500/24 title at 16, a bare 16px X ending 12 from the edge. */}
        <Header
          title={uiText("addModelSource")}
          layout="desktop"
          dialog
          inset={16}
          end={12}
          titleLine={24}
        >
          <View style={grow} />
          <CloseButton
            size={16}
            iconSize={16}
            style={{ paddingHorizontal: 0 }}
            disabled={busy()}
            onPress={close}
          />
        </Header>
      </If>
      <Scroll style={props.phone || login() ? grow : { flexShrink: 1 }}>
        <View style={login() ? { padding: 16, gap: 8 } : undefined}>
          <If
            when={login()}
            else={
              <>
                <If
                  when={props.phone}
                  else={
                    <SectionHeader
                      title={uiText("source")}
                      count={uiText("sourceStep", { step: 1 })}
                      description={uiText("pickWhereTheModelsComeFrom")}
                    />
                  }
                >
                  <SourceSteps />
                </If>
                <EntityRow
                  title="Eta Token Plan"
                  leading={<LetterBox name="Eta" />}
                  leadingSize={props.phone ? 28 : undefined}
                  stacked={props.phone}
                  meta={uiText("etasOwnGatewayOneKeyFor")}
                  status={{
                    label: uiText("sourceRecommended"),
                    color: c().blue,
                  }}
                  caret={!props.phone}
                  onPress={() => choose({ kind: "eta" })}
                />
                <SectionHeader
                  title={uiText("providerApiKeys")}
                  rowHeight={props.phone ? 20 : undefined}
                />
                <Each of={keySources}>
                  {(kind) => (
                    <SourceRow
                      phone={props.phone}
                      title={modelSource(kind())?.name ?? kind()}
                      onPress={() => choose({ kind: kind() })}
                    />
                  )}
                </Each>
                <If when={accounts()?.connectors.length}>
                  <SectionHeader
                    title={uiText("subscriptions")}
                    rowHeight={props.phone ? 20 : undefined}
                  />
                  <Each
                    of={accounts()?.connectors ?? []}
                    key={(connector) => connector.id}
                  >
                    {(connector) => (
                      <SourceRow
                        phone={props.phone}
                        title={connector().name}
                        onPress={() => {
                          if (!busy()) void start(connector().id);
                        }}
                      />
                    )}
                  </Each>
                </If>
                <SectionHeader
                  title={uiText("custom")}
                  rowHeight={props.phone ? 20 : undefined}
                />
                <SourceRow
                  phone={props.phone}
                  title={uiText("openaiCompatibleEndpoint")}
                  logo="OpenAI"
                  meta={
                    props.phone ? undefined : uiText("openaiCompatibleHint")
                  }
                  onPress={() => choose({ kind: "openai-compatible" })}
                />
                <SourceRow
                  phone={props.phone}
                  title={uiText("localModels")}
                  meta={uiText("localModelsHint")}
                  onPress={() =>
                    choose({ kind: "openai-compatible", local: true })
                  }
                />
              </>
            }
          >
            {(item) => (
              <>
                <Caption
                  text={
                    accounts()?.connectors.find(
                      (entry) => entry.id === item().connector,
                    )?.name ?? item().connector
                  }
                />
                <If
                  when={item().status === "pending"}
                  else={
                    <>
                      <Label tone="red">
                        {item().error?.message ?? uiText("thisSignInExpired")}
                      </Label>
                      <Button
                        label={uiText("chooseASource")}
                        onPress={() => login.set(undefined)}
                      />
                    </>
                  }
                >
                  <If
                    when={item().flow === "api_key"}
                    else={
                      <>
                        <If when={item().userCode}>
                          <Label
                            size={18}
                            style={{
                              padding: 9,
                              backgroundColor: c().selected,
                            }}
                          >
                            {item().userCode}
                          </Label>
                          <Button
                            label={uiText("copyCode")}
                            onPress={() =>
                              void host.action(() =>
                                Clipboard.writeText(item().userCode!),
                              )
                            }
                          />
                        </If>
                        <If when={item().url}>
                          <Button
                            label={uiText("openSignInPage")}
                            tone="primary"
                            onPress={() =>
                              void host.action(() => openUrl(item().url!))
                            }
                          />
                        </If>
                        <Label size={12} tone="muted">
                          {uiText("waitingForTheProviderToFinish")}
                        </Label>
                      </>
                    }
                  >
                    <Field
                      label="API key"
                      value={apiKey()}
                      masked
                      onChange={apiKey.set}
                      onSubmit={() => void submit()}
                    />
                    <Button
                      label={uiText("connect")}
                      tone="primary"
                      disabled={busy() || !apiKey().trim()}
                      onPress={() => void submit()}
                    />
                  </If>
                </If>
              </>
            )}
          </If>
        </View>
      </Scroll>
      <View
        style={{
          ...row,
          justifyContent: "flex-end",
          paddingHorizontal: 16,
          paddingVertical: props.phone ? 8 : 12,
          borderTopWidth: props.phone ? 1 : 0,
          borderColor: c().border,
        }}
      >
        <Button
          label={uiText("cancel")}
          size={props.phone ? 32 : undefined}
          style={{ paddingHorizontal: props.phone ? 14 : 12 }}
          onPress={close}
          disabled={busy()}
        />
      </View>
    </Modal>
  );
}

/** The phone's steps of adding a source; this sheet is the first. */
function SourceSteps() {
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
        height: 36,
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
              borderBottomWidth: index() === 0 ? 2 : 0,
              borderColor: c().ink,
            }}
          >
            <Label
              size={12}
              line={16}
              weight={index() === 0 ? 600 : 400}
              tone={index() === 0 ? "ink" : "mutedInk"}
            >
              {`${index() + 1} ${label()}`}
            </Label>
          </View>
        )}
      </Each>
    </View>
  );
}

/** A source to pick: an entity row in the dialog, a bare 28px logo and name on the phone. */
function SourceRow(props: {
  phone: boolean;
  title: string;
  logo?: string;
  meta?: string;
  onPress: () => void;
}) {
  const c = colors();
  return (
    <If
      when={props.phone}
      else={
        <EntityRow
          title={props.title}
          leading={<LetterBox name={props.logo ?? props.title} />}
          meta={props.meta}
          lane={false}
          caret
          onPress={props.onPress}
        />
      }
    >
      <View
        role="button"
        accessibilityLabel={props.title}
        onPress={props.onPress}
        style={{
          ...row,
          alignItems: props.meta ? "flex-start" : "center",
          flexShrink: 0,
          gap: 10,
          paddingHorizontal: 16,
          paddingVertical: 6,
          borderBottomWidth: 1,
          borderColor: c().border,
          cursor: "pointer",
        }}
      >
        <View
          style={{
            width: 28,
            height: 28,
            flexShrink: 0,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <LetterBox name={props.logo ?? props.title} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Label line={20} weight={500}>
            {props.title}
          </Label>
          <If when={props.meta}>
            <Label size={12} line={16} tone="muted">
              {props.meta}
            </Label>
          </If>
        </View>
      </View>
    </If>
  );
}
