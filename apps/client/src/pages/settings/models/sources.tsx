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
  Label,
  Modal,
  row,
} from "../../../components";
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
      height={login() ? 360 : 600}
      phone={props.phone}
      sheet={props.phone}
      overPhoneNavigation
      blurBackdrop={false}
      dismissible={!busy()}
      onClose={close}
    >
      <Scroll style={grow}>
        <View style={login() ? { padding: 16, gap: 8 } : undefined}>
          <If
            when={login()}
            else={
              <>
                <SectionHeader
                  title={uiText("source")}
                  count={uiText("sourceStep", { step: 1 })}
                  description={uiText("pickWhereTheModelsComeFrom")}
                />
                <EntityRow
                  title="Eta Token Plan"
                  leading={<LetterBox name="Eta" />}
                  meta={uiText("etasOwnGatewayOneKeyFor")}
                  status={{
                    label: uiText("sourceRecommended"),
                    color: c().blue,
                  }}
                  caret
                  onPress={() => choose({ kind: "eta" })}
                />
                <SectionHeader title={uiText("providerApiKeys")} />
                <Each of={keySources}>
                  {(kind) => (
                    <EntityRow
                      title={modelSource(kind())?.name ?? kind()}
                      leading={
                        <LetterBox name={modelSource(kind())?.name ?? kind()} />
                      }
                      lane={false}
                      caret
                      onPress={() => choose({ kind: kind() })}
                    />
                  )}
                </Each>
                <If when={accounts()?.connectors.length}>
                  <SectionHeader title={uiText("subscriptions")} />
                  <Each
                    of={accounts()?.connectors ?? []}
                    key={(connector) => connector.id}
                  >
                    {(connector) => (
                      <EntityRow
                        title={connector().name}
                        leading={<LetterBox name={connector().name} />}
                        lane={false}
                        caret
                        onPress={() => {
                          if (!busy()) void start(connector().id);
                        }}
                      />
                    )}
                  </Each>
                </If>
                <SectionHeader title={uiText("custom")} />
                <EntityRow
                  title={uiText("openaiCompatibleEndpoint")}
                  leading={<LetterBox name="OpenAI" />}
                  meta={uiText("openaiCompatibleHint")}
                  lane={false}
                  caret
                  onPress={() => choose({ kind: "openai-compatible" })}
                />
                <EntityRow
                  title={uiText("localModels")}
                  leading={<LetterBox name={uiText("localModels")} />}
                  meta={uiText("localModelsHint")}
                  lane={false}
                  caret
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
          paddingVertical: 12,
        }}
      >
        <Button
          label={uiText("cancel")}
          style={{ paddingHorizontal: 12 }}
          onPress={close}
          disabled={busy()}
        />
      </View>
    </Modal>
  );
}
