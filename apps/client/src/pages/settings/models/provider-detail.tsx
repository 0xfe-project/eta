import type {
  EtaModelConfig,
  ProviderCheck,
  ProviderCheckResult,
  ProviderRefreshResult,
  ProvidersView,
} from "@eta/client-contracts";
import { Scroll, signal, View } from "nsh";
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
import { ToggleSwitch } from "../../../components/toggle-switch";
import { uiText } from "../../../i18n";
import { useHost } from "../../../services/host";
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
  const query = signal("");
  const busy = signal("");
  const check = signal<ProviderCheck | undefined>(undefined);
  const section = signal<"Models" | "Connection">("Models");
  const connection = signal(false);
  const removing = signal(false);
  const candidates = () => {
    const found = new Map(catalog().map((model) => [model.id, model]));
    for (const model of provider()?.models ?? []) found.set(model.id, model);
    const term = query().trim().toLowerCase();
    return [...found.values()].filter((model) =>
      `${model.name ?? ""} ${model.id}`.toLowerCase().includes(term),
    );
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
  return (
    <View style={grow}>
      <Header
        title={provider()?.name ?? props.id}
        layout={props.phone ? "phone" : "desktop"}
        onBack={props.onClose}
        subtitle={
          check()
            ? check()?.state === "ok"
              ? uiText("working2")
              : uiText("needsAttention")
            : undefined
        }
        subtitleTone={check()?.state === "ok" ? "green" : "amber"}
      />
      <View style={{ ...row, borderBottomWidth: 1, borderColor: c().border }}>
        <Each of={["Models", "Connection"] as const}>
          {(tab) => (
            <Button
              label={uiText(tab() === "Models" ? "modelsTab" : "connectionTab")}
              size={40}
              tone="ghost"
              selected={section() === tab()}
              style={{
                flex: 1,
                borderBottomWidth: section() === tab() ? 2 : 0,
              }}
              onPress={() => section.set(tab())}
            />
          )}
        </Each>
      </View>
      <If
        when={section() === "Models"}
        else={
          <View style={{ padding: 16, gap: 8 }}>
            <Caption text={uiText("sourceConnection")} />
            <Label size={13}>{provider()?.baseUrl}</Label>
            <Label size={12} tone="muted">
              {provider()?.hasApiKey
                ? uiText("apiKeySavedOnTheHost")
                : uiText("noApiKeySaved")}
            </Label>
            <Button
              label={uiText("editConnection")}
              onPress={() => connection.set(true)}
            />
            <Button
              label={uiText("removeThisSource")}
              tone="danger"
              onPress={() => removing.set(true)}
            />
          </View>
        }
      >
        <View
          style={{
            ...row,
            gap: 8,
            paddingHorizontal: 16,
            minHeight: 44,
            borderBottomWidth: 1,
            borderColor: c().border,
          }}
        >
          <Label weight={600}>{uiText("models2")}</Label>
          <Label size={12} tone="muted" style={{ flex: 1 }}>
            {provider()?.models.length ?? 0}
          </Label>
          <Button
            label={busy() === "check" ? uiText("checking") : uiText("check")}
            disabled={!!busy()}
            onPress={() => void test()}
          />
          <Button
            label={
              busy() === "refresh"
                ? uiText("refreshing")
                : uiText("refreshList")
            }
            icon="refresh"
            disabled={!!busy()}
            onPress={() => void refresh()}
          />
        </View>
        <View
          style={{
            paddingHorizontal: 16,
            paddingVertical: 8,
            borderBottomWidth: 1,
            borderColor: c().border,
          }}
        >
          <Field
            label={uiText("searchModels")}
            placeholder={uiText("searchModels")}
            value={query()}
            onChange={query.set}
          />
          <If when={check()?.error}>
            <Label tone="red" size={12}>
              {check()?.error}
            </Label>
          </If>
        </View>
        <Scroll style={grow} scrollbar={false}>
          <Each of={candidates()} key={(model) => model.id}>
            {(model) => (
              <View
                style={{
                  ...row,
                  minHeight: 54,
                  gap: 12,
                  paddingHorizontal: 16,
                  paddingVertical: 7,
                  borderBottomWidth: 1,
                  borderColor: c().border,
                }}
              >
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Label tone={configured(model().id) ? "ink" : "muted"}>
                    {model().name ?? model().id}
                  </Label>
                  <Label size={11} tone={model().delisted ? "amber" : "muted"}>
                    {[
                      model().contextWindow
                        ? `${Math.round(model().contextWindow! / 1000)}K context`
                        : "",
                      model().reasoning ? "Reasoning" : "",
                      model().input?.includes("image") ? "Images" : "",
                      model().delisted
                        ? "Delisted"
                        : model().deprecated
                          ? "Deprecated"
                          : "",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </Label>
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
            <Label size={12} tone="muted" style={{ padding: 16 }}>
              {query()
                ? uiText("noMatchingModels")
                : uiText("refreshTheListToFindModels")}
            </Label>
          </If>
        </Scroll>
      </If>
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
                tone="danger"
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
