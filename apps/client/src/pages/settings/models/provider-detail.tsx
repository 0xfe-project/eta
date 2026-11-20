import type {
  EtaModelConfig,
  ProviderCheck,
  ProviderCheckResult,
  ProviderRefreshResult,
  ProvidersView,
} from "@eta/client-contracts";
import { providerLabel } from "@eta/client-contracts";
import { Scroll, signal, View } from "nsh";
import {
  Button,
  colors,
  Field,
  grow,
  Label,
  Modal,
  row,
} from "../../../components";
import { BackButton } from "../../../components/navigation-buttons";
import { StatusDot } from "../../../components/status-dot";
import { ToggleSwitch } from "../../../components/toggle-switch";
import { uiText } from "../../../i18n";
import { useHost } from "../../../services/host";
import { SectionHeader, WarningLine } from "../section";
import { ProviderEditor } from "./provider-editor";

export function ProviderDetail(props: {
  id: string;
  phone: boolean;
  onClose: () => void;
}) {
  const host = useHost();
  const c = colors();
  const config = () => host.section<ProvidersView>("providers", "config");
  const provider = () =>
    config()?.providers.find((item) => item.id === props.id);
  const catalog = signal<EtaModelConfig[]>(provider()?.models ?? []);
  const name = signal(provider()?.name ?? "");
  const busy = signal("");
  const check = signal<ProviderCheck | undefined>(undefined);
  const connection = signal(false);
  const removing = signal(false);
  const candidates = () => {
    const found = new Map(catalog().map((model) => [model.id, model]));
    for (const model of provider()?.models ?? []) found.set(model.id, model);
    return [...found.values()];
  };
  const configured = (id: string) =>
    provider()?.models.some((model) => model.id === id) ?? false;
  async function refresh() {
    if (busy()) return;
    busy.set("refresh");
    const result = await host.action(() =>
      host.call<ProviderRefreshResult>("providers", "refresh", {
        id: props.id,
      }),
    );
    if (result) catalog.set(result.models);
    busy.set("");
  }
  async function test() {
    if (busy()) return;
    busy.set("check");
    const result = await host.action(() =>
      host.call<ProviderCheckResult>("providers", "check", { id: props.id }),
    );
    if (result) check.set(result.checks[props.id]);
    busy.set("");
  }
  async function toggle(model: EtaModelConfig, enabled: boolean) {
    const current = provider();
    const state = config();
    if (busy() || !current || !state) return;
    if (enabled === configured(model.id)) return;
    busy.set("toggle");
    await host.action(() =>
      host.call("providers", "save", {
        revision: state.revision,
        provider: {
          id: current.id,
          name: current.name,
          baseUrl: current.baseUrl,
          kind: current.kind,
          headers: current.headers,
          models: enabled
            ? [...current.models, model]
            : current.models.filter((entry) => entry.id !== model.id),
        },
      }),
    );
    busy.set("");
  }
  async function remove() {
    const state = config();
    if (!state || busy()) return;
    busy.set("remove");
    const result = await host.action(() =>
      host.call("providers", "delete", {
        revision: state.revision,
        id: props.id,
      }),
    );
    busy.set("");
    if (result) props.onClose();
  }
  async function rename() {
    const current = provider();
    const state = config();
    const next = name().trim();
    if (busy() || !current || !state || !next || next === current.name) return;
    busy.set("rename");
    await host.action(() =>
      host.call("providers", "save", {
        revision: state.revision,
        provider: {
          id: current.id,
          name: next,
          baseUrl: current.baseUrl,
          kind: current.kind,
          headers: current.headers,
          models: current.models,
        },
      }),
    );
    busy.set("");
  }
  const modelMeta = (model: EtaModelConfig) =>
    [
      model.contextWindow
        ? `${Math.round(model.contextWindow / 1000)}K context`
        : "",
      model.reasoning ? "Reasoning" : "",
      model.input?.includes("image") ? "Images" : "",
      model.reasoning
        ? uiText("modelThinking", {
            level: model.defaultThinking ?? uiText("modelThinkingDefault"),
          })
        : "",
      model.deprecated ? "Deprecated" : "",
    ]
      .filter(Boolean)
      .join(" · ");
  const preference = {
    ...row,
    minHeight: 40,
    gap: 16,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderColor: c().border,
  } as const;
  return (
    <View style={grow}>
      <SectionHeader
        title={provider() ? providerLabel(provider()!) : props.id}
        leading={
          <BackButton style={{ marginLeft: -6 }} onPress={props.onClose} />
        }
      >
        <If when={check()}>
          <View style={{ ...row, gap: 6 }}>
            <StatusDot
              color={check()?.state === "ok" ? c().green : c().amber}
            />
            <Label size={12} line={16} tone="mutedInk">
              {check()?.state === "ok"
                ? uiText("sourceWorking")
                : check()?.state === "invalid_key"
                  ? uiText("sourceKeyRefused")
                  : uiText("sourceUnreachable")}
            </Label>
          </View>
        </If>
        <Button
          label={busy() === "check" ? uiText("checking") : uiText("check")}
          disabled={!!busy()}
          style={{ paddingHorizontal: 10 }}
          onPress={() => void test()}
        />
      </SectionHeader>
      <Scroll style={grow} scrollbar={false}>
        <If when={check()?.error}>
          <Label
            tone="red"
            size={12}
            line={16}
            style={{ paddingHorizontal: 16, paddingVertical: 8 }}
          >
            {check()?.error}
          </Label>
        </If>
        <View style={preference}>
          <Label line={20} style={{ flex: 1, minWidth: 0 }}>
            {uiText("name")}
          </Label>
          <Field
            label={uiText("name")}
            value={name()}
            onChange={name.set}
            onSubmit={() => void rename()}
            onBlur={() => void rename()}
            style={{
              width: 200,
              height: 24,
              fontSize: 12,
              lineHeight: 16,
              paddingHorizontal: 10,
              paddingVertical: 3,
              borderColor: c().strong,
            }}
          />
        </View>
        <View style={preference}>
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <Label line={20}>{uiText("sourceApiKey")}</Label>
            <Label size={12} line={16} tone="muted">
              {provider()?.hasApiKey
                ? uiText("apiKeySavedOnTheHost")
                : uiText("noApiKeySaved")}
            </Label>
          </View>
          <Button
            label={uiText("settingsChange")}
            style={{ paddingHorizontal: 10 }}
            onPress={() => connection.set(true)}
          />
        </View>
        <SectionHeader
          title={uiText("models2")}
          count={provider()?.models.length ?? 0}
        >
          <Button
            label={
              busy() === "refresh"
                ? uiText("refreshing")
                : uiText("refreshList")
            }
            icon="refresh"
            disabled={!!busy()}
            style={{ gap: 6, paddingHorizontal: 10 }}
            onPress={() => void refresh()}
          />
        </SectionHeader>
        <Each of={candidates()} key={(model) => model.id}>
          {(model) => (
            <View
              style={{
                ...row,
                gap: 10,
                paddingHorizontal: 16,
                paddingVertical: 8,
                borderBottomWidth: 1,
                borderColor: c().border,
              }}
            >
              <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                <Label
                  line={20}
                  weight={500}
                  tone={configured(model().id) ? "ink" : "muted"}
                >
                  {model().name ?? model().id}
                </Label>
                <If
                  when={model().delisted}
                  else={
                    <Label size={12} line={16} tone="muted">
                      {modelMeta(model())}
                    </Label>
                  }
                >
                  <WarningLine text={uiText("modelDelisted")} />
                </If>
              </View>
              <ToggleSwitch
                label={model().name ?? model().id}
                checked={configured(model().id)}
                disabled={!!busy()}
                onChange={(checked) => void toggle(model(), checked)}
              />
            </View>
          )}
        </Each>
        <If when={!candidates().length}>
          <Label size={12} line={16} tone="muted" style={{ padding: 16 }}>
            {uiText("refreshTheListToFindModels")}
          </Label>
        </If>
        <View style={preference}>
          <Label line={20} style={{ flex: 1, minWidth: 0 }}>
            {uiText("removeThisSource")}
          </Label>
          <Button
            label={uiText("remove2")}
            style={{ gap: 6, paddingHorizontal: 10 }}
            onPress={() => removing.set(true)}
          />
        </View>
      </Scroll>
      <If when={connection() && provider()}>
        <ProviderEditor
          item={provider()}
          revision={config()?.revision ?? ""}
          phone={props.phone}
          onClose={() => connection.set(false)}
        />
      </If>
      <If when={removing()}>
        <Modal
          title={uiText("removeThisSource2")}
          phone={props.phone}
          sheet={props.phone}
          onClose={() => removing.set(false)}
        >
          <View style={{ padding: 16, gap: 8 }}>
            <Label>{uiText("agentsUsingTheseModelsWillNeed")}</Label>
            <View style={{ ...row, gap: 8, justifyContent: "flex-end" }}>
              <Button
                label={uiText("cancel")}
                disabled={!!busy()}
                onPress={() => removing.set(false)}
              />
              <Button
                label={uiText("removeSource")}
                disabled={!!busy()}
                onPress={() => void remove()}
              />
            </View>
          </View>
        </Modal>
      </If>
    </View>
  );
}
