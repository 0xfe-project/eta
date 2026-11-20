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
  Icon,
  Label,
  Modal,
  row,
} from "../../../components";
import { StatusDot } from "../../../components/status-dot";
import { ToggleSwitch } from "../../../components/toggle-switch";
import { uiText } from "../../../i18n";
import { useHost } from "../../../services/host";
import { PaneBack, SectionHeader, WarningLine } from "../section";
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
  const tab = signal<"models" | "connection">("models");
  const query = signal("");
  const advanced = signal(false);
  const removing = signal(false);
  const candidates = () => {
    const found = new Map(catalog().map((model) => [model.id, model]));
    for (const model of provider()?.models ?? []) found.set(model.id, model);
    return [...found.values()];
  };
  const shown = () => {
    const needle = query().trim().toLowerCase();
    return needle
      ? candidates().filter((model) =>
          `${model.name ?? ""} ${model.id}`.toLowerCase().includes(needle),
        )
      : candidates();
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
  /** Removing the source: pinned under the pane off phones, under the rows on a phone. */
  const removeRow = () => (
    <View
      style={{
        ...preference,
        ...(props.phone ? {} : { borderBottomWidth: 0, borderTopWidth: 1 }),
      }}
    >
      <Label line={20} style={{ flex: 1, minWidth: 0 }}>
        {uiText("removeThisSource")}
      </Label>
      <Button
        label={uiText("remove2")}
        icon="trash"
        style={{ gap: 6, paddingHorizontal: 10 }}
        onPress={() => removing.set(true)}
      />
    </View>
  );
  return (
    <View style={grow}>
      <SectionHeader
        title={provider() ? providerLabel(provider()!) : props.id}
        leading={<PaneBack onPress={props.onClose} />}
        phone={props.phone}
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
      <View
        role="tablist"
        style={{
          ...row,
          alignItems: "stretch",
          height: 40,
          flexShrink: 0,
          gap: props.phone ? 0 : 20,
          paddingHorizontal: props.phone ? 0 : 16,
          borderBottomWidth: 1,
          borderColor: c().border,
        }}
      >
        <Each of={["models", "connection"] as const}>
          {(item) => (
            <View
              role="tab"
              accessibilityState={{ selected: tab() === item() }}
              accessibilityLabel={
                item() === "models"
                  ? uiText("models2")
                  : uiText("sourceConnectionTab")
              }
              onPress={() => tab.set(item())}
              style={{
                ...row,
                gap: 6,
                ...(props.phone ? { flex: 1, justifyContent: "center" } : {}),
                borderBottomWidth: 2,
                borderColor: tab() === item() ? c().ink : "transparent",
                cursor: "pointer",
              }}
            >
              <Label
                size={props.phone ? 12 : undefined}
                line={props.phone ? 16 : 20}
                weight={tab() === item() ? (props.phone ? 600 : 500) : 400}
                tone={
                  tab() === item() ? "ink" : props.phone ? "mutedInk" : "muted"
                }
              >
                {item() === "models"
                  ? uiText("models2")
                  : uiText("sourceConnectionTab")}
              </Label>
              <If when={item() === "models" && !props.phone}>
                <Label size={12} line={16} tone="muted">
                  {provider()?.models.length ?? 0}
                </Label>
              </If>
            </View>
          )}
        </Each>
      </View>
      <If when={check()?.error}>
        <Label
          tone="red"
          size={12}
          line={16}
          style={{
            paddingHorizontal: 16,
            paddingVertical: 8,
            borderBottomWidth: 1,
            borderColor: c().border,
          }}
        >
          {check()?.error}
        </Label>
      </If>
      <If
        when={tab() === "models"}
        else={
          <>
            <Scroll style={grow} scrollbar={false}>
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
                    width: props.phone ? 160 : 200,
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
              <View
                role="button"
                accessibilityLabel={uiText("sourceAdvanced")}
                accessibilityState={{ expanded: advanced() }}
                onPress={() => advanced.set(!advanced())}
                hoverStyle={{ backgroundColor: c().selected }}
                style={{ ...preference, gap: 8, cursor: "pointer" }}
              >
                <Icon
                  name={advanced() ? "down" : "right"}
                  size={12}
                  tone="mutedInk"
                />
                <Label line={20}>{uiText("sourceAdvanced")}</Label>
              </View>
              <If when={advanced()}>
                <View style={preference}>
                  <Label line={20} style={{ flexShrink: 0 }}>
                    {uiText("sourceUrl")}
                  </Label>
                  <Label
                    size={12}
                    line={16}
                    lines={1}
                    tone="mutedInk"
                    style={{ flex: 1, minWidth: 0, textAlign: "right" }}
                  >
                    {provider()?.baseUrl ?? ""}
                  </Label>
                </View>
                <View style={preference}>
                  <Label line={20} style={{ flexShrink: 0 }}>
                    {uiText("sourceHeaders")}
                  </Label>
                  <Label
                    size={12}
                    line={16}
                    lines={2}
                    tone="mutedInk"
                    style={{ flex: 1, minWidth: 0, textAlign: "right" }}
                  >
                    {Object.keys(provider()?.headers ?? {}).join(", ") ||
                      uiText("sourceNoHeaders")}
                  </Label>
                  <Button
                    label={uiText("settingsChange")}
                    style={{ paddingHorizontal: 10 }}
                    onPress={() => connection.set(true)}
                  />
                </View>
              </If>
              <If when={props.phone}>{removeRow()}</If>
            </Scroll>
            <If when={!props.phone}>{removeRow()}</If>
          </>
        }
      >
        <View
          style={{
            ...row,
            gap: 8,
            paddingHorizontal: 16,
            paddingVertical: 8,
            flexShrink: 0,
            borderBottomWidth: 1,
            borderColor: c().border,
          }}
        >
          <View
            style={{
              ...row,
              height: 24,
              gap: 8,
              paddingHorizontal: 10,
              borderWidth: 1,
              borderColor: c().strong,
              ...(props.phone ? { flex: 1, minWidth: 0 } : { width: 240 }),
            }}
          >
            <Icon name="search" size={12} tone="muted" />
            <Field
              label={uiText("searchModels")}
              placeholder={uiText("searchModels")}
              value={query()}
              onChange={query.set}
              style={{
                flex: 1,
                height: 22,
                paddingHorizontal: 0,
                paddingVertical: 3,
                borderWidth: 0,
                fontSize: 12,
                lineHeight: 16,
              }}
            />
          </View>
          <If when={!props.phone}>
            <View style={grow} />
          </If>
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
        </View>
        <Scroll style={grow} scrollbar={false}>
          <Each of={shown()} key={(model) => model.id}>
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
          <If when={!shown().length}>
            <Label size={12} line={16} tone="muted" style={{ padding: 16 }}>
              {query().trim()
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
