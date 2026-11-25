import type {
  EtaModelConfig,
  ProviderCheck,
  ProviderCheckResult,
  ProviderRefreshResult,
  ProvidersView,
} from "@eta/client-contracts";
import { providerLabel } from "@eta/client-contracts";
import { signal, View } from "nsh";
import {
  Button,
  colors,
  Field,
  grow,
  Icon,
  Label,
  Modal,
  row,
  SmoothScroll,
  textFaces,
  textStyle,
} from "../../../components";
import { StatusDot } from "../../../components/status-dot";
import { ToggleSwitch } from "../../../components/toggle-switch";
import {
  border,
  control,
  icon,
  space,
  weight,
} from "../../../components/tokens";
import { uiText } from "../../../i18n";
import { useHost } from "../../../services/host";
import { problemText } from "../../../services/problem-text";
import { Tabs } from "../../../ui";
import { LetterBox, PaneBack, SectionHeader, WarningLine } from "../section";
import { logoKey, useSourceLogos } from "./logos";
import { ProviderEditor } from "./provider-editor";

/** The source's name field (narrower on phones) and the model search. */
const nameWidth = 200;
const phoneNameWidth = 160;
const searchWidth = 240;

export function ProviderDetail(props: {
  id: string;
  phone: boolean;
  onClose: () => void;
}) {
  const host = useHost();
  const logo = useSourceLogos();
  const c = colors();
  const type = textFaces();
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
    minHeight: space[40],
    gap: space[16],
    paddingHorizontal: space[16],
    paddingVertical: space[8],
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
      <Label style={{ flex: 1, minWidth: 0 }}>
        {uiText("removeThisSource")}
      </Label>
      <Button
        label={uiText("remove2")}
        icon="trash"
        style={{ gap: space[4], paddingHorizontal: space[12] }}
        onPress={() => removing.set(true)}
      />
    </View>
  );
  return (
    <View style={grow}>
      <SectionHeader
        title={provider() ? providerLabel(provider()!) : props.id}
        leading={
          <>
            <PaneBack onPress={props.onClose} />
            {/* The phone's header names the source by its logo too; the desktop pane does not. */}
            <If when={props.phone}>
              <LetterBox
                name={provider() ? providerLabel(provider()!) : props.id}
                logo={logo(logoKey.provider(props.id))}
              />
            </If>
          </>
        }
        phone={props.phone}
      >
        <If when={check()}>
          <View style={{ ...row, gap: space[4] }}>
            <StatusDot
              color={check()?.state === "ok" ? c().green : c().warning}
            />
            <Label variant="small" tone="mutedInk">
              {check()?.state === "ok"
                ? uiText("sourceWorking")
                : check()?.state === "invalid_key"
                  ? uiText("sourceKeyRefused")
                  : uiText("sourceUnreachable")}
            </Label>
          </View>
        </If>
        <Button
          label={uiText("check")}
          disabled={!!busy() && busy() !== "check"}
          busy={busy() === "check"}
          style={{ paddingHorizontal: space[12] }}
          onPress={() => void test()}
        />
      </SectionHeader>
      <Tabs
        value={tab()}
        stretch={props.phone}
        options={[
          {
            value: "models" as const,
            label: uiText("models2"),
            count: props.phone ? undefined : (provider()?.models.length ?? 0),
          },
          {
            value: "connection" as const,
            label: uiText("sourceConnectionTab"),
          },
        ]}
        onChange={tab.set}
      />
      <If when={check()?.error}>
        <Label
          tone="red"
          variant="small"
          style={{
            paddingHorizontal: space[16],
            paddingVertical: space[8],
            borderBottomWidth: 1,
            borderColor: c().border,
          }}
        >
          {problemText(check()?.error ?? "")}
        </Label>
      </If>
      <If
        when={tab() === "models"}
        else={
          <>
            <SmoothScroll style={grow} scrollbar={false}>
              <View style={preference}>
                <Label style={{ flex: 1, minWidth: 0 }}>{uiText("name")}</Label>
                <Field
                  label={uiText("name")}
                  value={name()}
                  onChange={name.set}
                  onSubmit={() => void rename()}
                  onBlur={() => void rename()}
                  style={{
                    width: props.phone ? phoneNameWidth : nameWidth,
                    height: space[24],
                    ...textStyle(type("small")),
                    paddingHorizontal: space[12],
                    paddingVertical: space[4],
                    borderColor: c().strong,
                  }}
                />
              </View>
              <View style={preference}>
                <View style={{ flex: 1, minWidth: 0, gap: space[2] }}>
                  <Label>{uiText("sourceApiKey")}</Label>
                  <Label variant="small" tone="muted">
                    {provider()?.hasApiKey
                      ? uiText("apiKeySavedOnTheHost")
                      : uiText("noApiKeySaved")}
                  </Label>
                </View>
                <Button
                  label={uiText("settingsChange")}
                  style={{ paddingHorizontal: space[12] }}
                  onPress={() => connection.set(true)}
                />
              </View>
              <View
                role="button"
                accessibilityLabel={uiText("sourceAdvanced")}
                accessibilityState={{ expanded: advanced() }}
                onPress={() => advanced.set(!advanced())}
                hoverStyle={{ backgroundColor: c().selected }}
                style={{ ...preference, gap: space[8], cursor: "pointer" }}
              >
                <Icon
                  name={advanced() ? "down" : "right"}
                  size={icon.sm}
                  tone="mutedInk"
                />
                <Label>{uiText("sourceAdvanced")}</Label>
              </View>
              <If when={advanced()}>
                <View style={preference}>
                  <Label style={{ flexShrink: 0 }}>{uiText("sourceUrl")}</Label>
                  <Label
                    variant="small"
                    lines={1}
                    tone="mutedInk"
                    style={{ flex: 1, minWidth: 0, textAlign: "right" }}
                  >
                    {provider()?.baseUrl ?? ""}
                  </Label>
                </View>
                <View style={preference}>
                  <Label style={{ flexShrink: 0 }}>
                    {uiText("sourceHeaders")}
                  </Label>
                  <Label
                    variant="small"
                    lines={2}
                    tone="mutedInk"
                    style={{ flex: 1, minWidth: 0, textAlign: "right" }}
                  >
                    {Object.keys(provider()?.headers ?? {}).join(", ") ||
                      uiText("sourceNoHeaders")}
                  </Label>
                  <Button
                    label={uiText("settingsChange")}
                    style={{ paddingHorizontal: space[12] }}
                    onPress={() => connection.set(true)}
                  />
                </View>
              </If>
              <If when={props.phone}>{removeRow()}</If>
            </SmoothScroll>
            <If when={!props.phone}>{removeRow()}</If>
          </>
        }
      >
        <View
          style={{
            ...row,
            gap: space[8],
            paddingHorizontal: space[16],
            paddingVertical: space[8],
            flexShrink: 0,
            borderBottomWidth: 1,
            borderColor: c().border,
          }}
        >
          <View
            style={{
              ...row,
              height: space[24],
              gap: space[8],
              paddingHorizontal: space[12],
              borderWidth: 1,
              borderColor: c().strong,
              ...(props.phone
                ? { flex: 1, minWidth: 0 }
                : { width: searchWidth }),
            }}
          >
            <Icon name="search" size={icon.sm} tone="muted" />
            <Field
              label={uiText("searchModels")}
              placeholder={uiText("searchModels")}
              value={query()}
              onChange={query.set}
              style={{
                flex: 1,
                height: control.sm - 2 * border.hair,
                paddingHorizontal: 0,
                paddingVertical: space[4],
                borderWidth: 0,
                ...textStyle(type("small")),
              }}
            />
          </View>
          <If when={!props.phone}>
            <View style={grow} />
          </If>
          <Button
            label={uiText("refreshList")}
            icon="refresh"
            spinIcon
            disabled={!!busy() && busy() !== "refresh"}
            busy={busy() === "refresh"}
            style={{ gap: space[4], paddingHorizontal: space[12] }}
            onPress={() => void refresh()}
          />
        </View>
        <SmoothScroll style={grow} scrollbar={false}>
          <Each of={shown()} key={(model) => model.id}>
            {(model) => (
              <View
                style={{
                  ...row,
                  gap: space[8],
                  paddingHorizontal: space[16],
                  paddingVertical: space[8],
                  borderBottomWidth: 1,
                  borderColor: c().border,
                }}
              >
                <View style={{ flex: 1, minWidth: 0, gap: space[2] }}>
                  <Label
                    weight={weight.regular}
                    tone={configured(model().id) ? "ink" : "muted"}
                  >
                    {model().name ?? model().id}
                  </Label>
                  <If
                    when={model().delisted}
                    else={
                      <Label variant="small" tone="muted">
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
            <Label variant="small" tone="muted" style={{ padding: space[16] }}>
              {query().trim()
                ? uiText("noMatchingModels")
                : uiText("refreshTheListToFindModels")}
            </Label>
          </If>
        </SmoothScroll>
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
          <View style={{ padding: space[16], gap: space[8] }}>
            <Label>{uiText("agentsUsingTheseModelsWillNeed")}</Label>
            <View style={{ ...row, gap: space[8], justifyContent: "flex-end" }}>
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
