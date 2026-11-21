import type {
  LlmAccounts,
  LlmConnection,
  LlmModel,
  LlmQuota,
  ProviderCheck,
  ProviderSummary,
  ProvidersView,
} from "@eta/client-contracts";
import type { ViewRef } from "nsh";
import type { EntityStatus } from "../section";
import { keyMissing, providerLabel } from "@eta/client-contracts";
import { View } from "nsh";
import { ActionItem, colors, Label, row } from "../../../components";
import { uiText } from "../../../i18n";
import { useHost } from "../../../services/host";
import { EntityRow, LetterBox } from "../section";
import { logoKey, useSourceLogos } from "./logos";
import {
  accountQuota,
  billingClock,
  currentPercent,
  monthlyWindows,
  percentText,
} from "./quota";

/** Every model source in one list: the gateway's accounts first, then the config's providers. */
export function useModelSources() {
  const host = useHost();
  const providers = () =>
    host.section<ProvidersView>("providers", "config")?.providers ?? [];
  const accounts = () =>
    host.section<LlmAccounts>("llm", "accounts")?.connections ?? [];
  const count = () => providers().length + accounts().length;
  return { providers, accounts, count };
}

export function ModelSourceList(props: {
  phone: boolean;
  onProvider: (provider: ProviderSummary) => void;
  /** Opens an account's subscription detail. */
  onAccount: (id: string, connector: string) => void;
  /** Each row's pressable part, keyed `account:<id>` or `source:<id>`. */
  onRef: (key: string, node: ViewRef) => void;
}) {
  const host = useHost();
  const now = billingClock();
  const c = colors();
  const { providers, accounts } = useModelSources();
  const logo = useSourceLogos();
  const checks = () =>
    host.section<Record<string, ProviderCheck>>("providers", "checks") ?? {};
  const models = () => host.list<LlmModel>("llm", "models");
  const connector = (item: LlmConnection) =>
    host
      .section<LlmAccounts>("llm", "accounts")
      ?.connectors.find((entry) => entry.id === item.connector);
  const providerStatus = (item: ProviderSummary): EntityStatus => {
    const check = checks()[item.id];
    if (keyMissing(item))
      return { label: uiText("sourceNeedsKey"), color: c().amber };
    if (check?.state === "invalid_key")
      return { label: uiText("sourceKeyRefused"), color: c().red };
    if (check?.state === "unreachable")
      return { label: uiText("sourceUnreachable"), color: c().red };
    return { label: uiText("sourceWorking"), color: c().green };
  };
  /** This month's used share, when the connector has this one account and it reports one monthly window. */
  const used = (item: LlmConnection) => {
    const group = accounts().filter(
      (entry) => entry.connector === item.connector,
    );
    if (
      group.length !== 1 ||
      group[0]?.id !== item.id ||
      item.state === "disabled"
    )
      return undefined;
    const quota = accountQuota(host.section<LlmQuota[]>("llm", "quota"), item);
    const windows = monthlyWindows(quota);
    return quota && windows.length === 1
      ? currentPercent(quota, windows[0]!, now())
      : undefined;
  };
  const usedText = (item: LlmConnection) => {
    const value = used(item);
    return value === undefined
      ? undefined
      : `${uiText("modelQuotaMonthly")} · ${uiText("modelQuotaUsed", { percent: percentText(value) })}`;
  };
  const modelCount = (item: LlmConnection) =>
    uiText("sourceModelCount", {
      count: models().filter(
        (model) => model.connector === item.connector && model.available,
      ).length,
    });
  const accountStatus = (item: LlmConnection): EntityStatus => {
    if (item.state === "disabled")
      return { label: uiText("sourceDisabled"), color: c().faint };
    if (item.state === "needs_login" || item.state === "error")
      return item.error?.code === "invalid_api_key"
        ? { label: uiText("sourceKeyRefused"), color: c().red }
        : { label: uiText("sourceNeedsLogin"), color: c().amber };
    return { label: uiText("sourceWorking"), color: c().green };
  };
  return (
    <>
      <Each of={accounts()} key={(item) => item.id}>
        {(item) => (
          <EntityRow
            title={connector(item())?.name ?? item().label}
            titleTone={item().state === "disabled" ? "muted" : "ink"}
            leading={
              <LetterBox
                name={connector(item())?.name ?? item().label}
                logo={logo(logoKey.connector(item().connector))}
              />
            }
            meta={
              <View style={{ ...row, gap: 10 }}>
                <Label variant="small" tone="muted">
                  {modelCount(item())}
                </Label>
                <If when={!props.phone && used(item()) !== undefined}>
                  <View
                    style={{
                      width: 56,
                      height: 4,
                      borderWidth: 1,
                      borderColor: c().strong,
                    }}
                  >
                    <View
                      style={{
                        width: (54 * (used(item()) ?? 0)) / 100,
                        height: 2,
                        backgroundColor: c().ink,
                      }}
                    />
                  </View>
                </If>
              </View>
            }
            status={accountStatus(item())}
            accessibilityLabel={[
              item().label,
              item().connector,
              item().state,
              props.phone ? undefined : usedText(item()),
            ]
              .filter(Boolean)
              .join(" · ")}
            controlRef={(node) => props.onRef(`account:${item().id}`, node)}
            onPress={() => props.onAccount(item().id, item().connector)}
            menuLabel={item().label}
            menu={
              <ActionItem
                label={
                  item().state === "disabled"
                    ? uiText("enable")
                    : uiText("disable")
                }
                onSelect={() =>
                  void host.action(() =>
                    host.call("llm", "setEnabled", {
                      id: item().id,
                      enabled: item().state === "disabled",
                    }),
                  )
                }
              />
            }
          />
        )}
      </Each>
      <Each of={providers()} key={(item) => item.id}>
        {(item) => (
          <EntityRow
            title={providerLabel(item())}
            leading={
              <LetterBox
                name={providerLabel(item())}
                logo={logo(logoKey.provider(item().id))}
              />
            }
            meta={uiText("sourceModelCount", { count: item().models.length })}
            status={providerStatus(item())}
            caret
            controlRef={(node) => props.onRef(`source:${item().id}`, node)}
            onPress={() => props.onProvider(item())}
          />
        )}
      </Each>
    </>
  );
}
