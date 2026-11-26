import type {
  LlmAccounts,
  LlmConnection,
  LlmModel,
  ProviderCheck,
  ProviderSummary,
  ProvidersView,
  SourceQuota,
} from "@eta/client-contracts";
import type { ViewRef } from "nsh";
import type { EntityStatus } from "../section";
import type { DisplayedSourceSummary } from "./source-summaries";
import { keyMissing, providerLabel } from "@eta/client-contracts";
import { signal, View, windowSize } from "nsh";
import { ActionItem, colors, Label, row } from "../../../components";
import { showToast } from "../../../components/toast";
import { opacity, space } from "../../../components/tokens";
import { formatLocale, uiText } from "../../../i18n";
import { useHost } from "../../../services/host";
import { EntityRow, LetterBox } from "../section";
import { logoKey, useSourceLogos } from "./logos";
import { billingClock, localTime, percentText } from "./quota";

/** The bar showing how much of a source's quota is used. */
const usageBarWidth = 56;

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
  summaries: DisplayedSourceSummary[];
  onProvider: (provider: ProviderSummary) => void;
  /** Opens an account's subscription detail. */
  onAccount: (id: string, connector: string) => void;
  /** Each row's pressable part, keyed `account:<id>` or `source:<id>`. */
  onRef: (key: string, node: ViewRef) => void;
}) {
  const host = useHost();
  const now = billingClock();
  const narrow = () => props.phone && windowSize().width <= 320;
  const c = colors();
  const { providers, accounts: rawAccounts } = useModelSources();
  const pendingEnabled = signal<Record<string, boolean>>({});
  const accounts = () => {
    const overrides = pendingEnabled();
    if (!Object.keys(overrides).length) return rawAccounts();
    return rawAccounts().map((account) => {
      if (!(account.id in overrides)) return account;
      const enabled = overrides[account.id];
      return {
        ...account,
        state: enabled
          ? account.state === "disabled"
            ? ("active" as const)
            : account.state
          : ("disabled" as const),
      };
    });
  };
  function toggleAccount(id: string, enabled: boolean) {
    pendingEnabled.update((all) => ({ ...all, [id]: enabled }));
    void host
      .call("llm", "setEnabled", { id, enabled })
      .then(() => {
        setTimeout(() => {
          pendingEnabled.update((all) => {
            if (all[id] !== enabled) return all;
            const { [id]: _, ...rest } = all;
            return rest;
          });
        }, 1500);
      })
      .catch((problem: unknown) => {
        pendingEnabled.update((all) => {
          if (all[id] !== enabled) return all;
          const { [id]: _, ...rest } = all;
          return rest;
        });
        showToast({
          title: uiText("saveFailed"),
          body: problem instanceof Error ? problem.message : String(problem),
          tone: "red",
          action: {
            label: uiText("retry"),
            onPress: () => toggleAccount(id, enabled),
          },
        });
      });
  }
  const logo = useSourceLogos();
  const checks = () =>
    host.section<Record<string, ProviderCheck>>("providers", "checks") ?? {};
  const models = () => host.list<LlmModel>("llm", "models");
  const connector = (item: LlmConnection) =>
    host
      .section<LlmAccounts>("llm", "accounts")
      ?.connectors.find((entry) => entry.id === item.connector);
  const accountTitle = (account: LlmConnection) => {
    const name = connector(account)?.name ?? account.connector;
    const peers = accounts().filter((a) => a.connector === account.connector);
    if (peers.length < 2) return name;
    const ambiguous = peers.some(
      (a) => a.id !== account.id && a.label === account.label,
    );
    return `${name} · ${account.label}${ambiguous ? ` (${account.id})` : ""}`;
  };
  const providerStatus = (item: ProviderSummary): EntityStatus => {
    const check = checks()[item.id];
    if (keyMissing(item))
      return { label: uiText("sourceNeedsKey"), color: c().warning };
    if (check?.state === "invalid_key")
      return { label: uiText("sourceKeyRefused"), color: c().red };
    if (check?.state === "unreachable")
      return { label: uiText("sourceUnreachable"), color: c().red };
    return { label: uiText("sourceWorking"), color: c().green };
  };
  const quota = (item: LlmConnection) => {
    const match = props.summaries.find(
      (s) => s.source === "account" && s.id === item.id,
    );
    if (
      item.state !== "active" ||
      !item.quotaRevision ||
      match?.source !== "account" ||
      match.quotaRevision !== item.quotaRevision
    )
      return undefined;
    const value = match.value?.quota;
    return value && (!value.resetsAt || Date.parse(value.resetsAt) > now())
      ? { ...value, previousAt: match.previousAt }
      : undefined;
  };
  const usedText = (value: SourceQuota) =>
    uiText("modelWeeklyUsed", {
      percent: percentText(value.usedPercent),
    });
  const balance = (item: ProviderSummary) => {
    const match = props.summaries.find(
      (s) => s.source === "provider" && s.id === item.id,
    );
    return item.balanceRevision &&
      match?.source === "provider" &&
      match.balanceRevision === item.balanceRevision &&
      match.value
      ? {
          amounts: match.value.balance.lines.map(
            (line) =>
              `${line.currency} ${/^-?0+(?:\.0+)?$/.test(line.available) ? "0.00" : line.available}`,
          ),
          previousAt: match.previousAt,
        }
      : undefined;
  };
  const previousText = (time: number) =>
    uiText("modelBillingPrevious", {
      time: new Intl.DateTimeFormat(formatLocale(), {
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(time),
    });
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
        : { label: uiText("sourceNeedsLogin"), color: c().warning };
    return { label: uiText("sourceWorking"), color: c().green };
  };
  return (
    <>
      <Each of={accounts()} key={(item) => item.id}>
        {(item) => (
          <EntityRow
            title={accountTitle(item())}
            titleTone={item().state === "disabled" ? "muted" : "ink"}
            leading={
              <LetterBox
                name={connector(item())?.name ?? item().label}
                logo={logo(logoKey.connector(item().connector))}
              />
            }
            meta={
              <View style={{ gap: space[2] }}>
                <View
                  style={{
                    ...row,
                    flexWrap: "wrap",
                    columnGap: space[8],
                    rowGap: space[2],
                  }}
                >
                  <Label variant="small" tone="muted">
                    {modelCount(item())}
                  </Label>
                  <If when={quota(item())}>
                    {(value) => (
                      <View
                        style={{
                          ...row,
                          gap: space[4],
                          maxWidth: "100%",
                          opacity:
                            value().previousAt === undefined
                              ? 1
                              : opacity.muted,
                        }}
                      >
                        <View
                          style={{
                            width: usageBarWidth,
                            height: space[4],
                            flexShrink: 0,
                            borderWidth: 1,
                            borderColor: c().strong,
                          }}
                        >
                          <View
                            style={{
                              width: (54 * value().usedPercent) / 100,
                              height: space[2],
                              backgroundColor: c().ink,
                            }}
                          />
                        </View>
                        <Label variant="small" tone="muted">
                          {usedText(value())}
                        </Label>
                      </View>
                    )}
                  </If>
                </View>
                <If when={quota(item())?.resetsAt}>
                  {(time) => (
                    <Label
                      variant="small"
                      tone="muted"
                      style={{
                        opacity:
                          quota(item())?.previousAt === undefined
                            ? 1
                            : opacity.muted,
                      }}
                    >
                      {uiText("modelQuotaResetsAt", {
                        time: localTime(time()),
                      })}
                    </Label>
                  )}
                </If>
                <If when={quota(item())?.previousAt}>
                  {(time) => (
                    <Label variant="small" tone="muted">
                      {previousText(time())}
                    </Label>
                  )}
                </If>
              </View>
            }
            wideMeta={props.phone}
            status={accountStatus(item())}
            accessibilityLabel={[
              item().label,
              item().connector,
              item().state,
              quota(item()) && usedText(quota(item())!),
              quota(item())?.resetsAt &&
                uiText("modelQuotaResetsAt", {
                  time: localTime(quota(item())?.resetsAt),
                }),
              quota(item())?.previousAt &&
                previousText(quota(item())!.previousAt!),
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
                  toggleAccount(item().id, item().state === "disabled")
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
            meta={
              <View style={{ gap: space[2] }}>
                <View
                  style={
                    narrow()
                      ? { alignItems: "flex-start", gap: space[4] }
                      : {
                          ...row,
                          alignItems: "flex-start",
                          gap: props.phone ? space[16] : space[8],
                        }
                  }
                >
                  <Label variant="small" tone="muted">
                    {uiText("sourceModelCount", {
                      count: item().models.length,
                    })}
                  </Label>
                  <If when={balance(item())}>
                    {(value) => (
                      <View
                        style={{
                          ...(narrow()
                            ? { alignItems: "flex-start" as const }
                            : { ...row, flex: 1 }),
                          minWidth: 0,
                          flexWrap: "wrap",
                          columnGap: space[8],
                          rowGap: narrow() ? space[4] : space[2],
                          opacity:
                            value().previousAt === undefined
                              ? 1
                              : opacity.muted,
                        }}
                      >
                        <Each of={value().amounts}>
                          {(amount) => (
                            <Label variant="small" tone="muted">
                              {amount()}
                            </Label>
                          )}
                        </Each>
                      </View>
                    )}
                  </If>
                </View>
                <If when={balance(item())?.previousAt}>
                  {(time) => (
                    <Label variant="small" tone="muted">
                      {previousText(time())}
                    </Label>
                  )}
                </If>
              </View>
            }
            wideMeta={props.phone}
            accessibilityLabel={[
              providerLabel(item()),
              ...(balance(item())?.amounts ?? []),
              balance(item())?.previousAt &&
                previousText(balance(item())!.previousAt!),
            ]
              .filter(Boolean)
              .join(" · ")}
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
