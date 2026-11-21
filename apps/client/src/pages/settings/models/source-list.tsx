import type {
  LlmAccounts,
  LlmConnection,
  LlmModel,
  ProviderCheck,
  ProviderSummary,
  ProvidersView,
  SourceSummaries,
  SourceSummary,
} from "@eta/client-contracts";
import type { ViewRef } from "nsh";
import type { EntityStatus } from "../section";
import { keyMissing, providerLabel } from "@eta/client-contracts";
import {
  cleanup,
  computed,
  effect,
  signal,
  untracked,
  View,
  windowSize,
} from "nsh";
import { ActionItem, colors, Label, row } from "../../../components";
import { space } from "../../../components/tokens";
import { uiText } from "../../../i18n";
import { useHost } from "../../../services/host";
import { EntityRow, LetterBox } from "../section";
import { logoKey, useSourceLogos } from "./logos";
import { billingClock, localTime, percentText } from "./quota";

/** The settings pane owns the visit, even when a breakpoint remounts the row layout. */
export function useSourceSummaries(visible: () => boolean) {
  const host = useHost();
  const { providers, accounts, count } = useModelSources();
  const items = signal<SourceSummary[]>([]);
  const available = computed(
    () =>
      visible() &&
      host.state().status === "open" &&
      host.can("billing.readSourceSummaries"),
  );
  effect(() => {
    const address = host.address();
    items.set([]);
    if (!available()) return;
    let active = true;
    cleanup(() => {
      active = false;
    });
    // Each wave of four upstream reads has a 15-second deadline.
    const sourceCount = untracked(count);
    // Retiring a row or replacing its credential ends its eligibility for this visit,
    // even if a new row subsequently uses the same id and key.
    let previous = new Map<string, string | undefined>();
    const retired = new Set<string>();
    const retained = (item: SourceSummary) =>
      !retired.has(`${item.source}:${item.id}`);
    effect(() => {
      const current = new Map<string, string | undefined>([
        ...providers().map(
          (p) => [`provider:${p.id}`, p.balanceRevision] as const,
        ),
        ...accounts().map((a) => [`account:${a.id}`, a.quotaRevision] as const),
      ]);
      for (const [id, revision] of previous) {
        if (!current.has(id) || current.get(id) !== revision) retired.add(id);
      }
      previous = current;
      const shown = untracked(items);
      if (shown.some((item) => !retained(item)))
        items.set(shown.filter(retained));
    });
    void host
      .call<SourceSummaries>(
        "billing",
        "readSourceSummaries",
        {},
        { timeoutMs: 30_000 + 15_000 * Math.ceil(sourceCount / 4) },
      )
      .then((result) => {
        if (active && available() && host.address() === address)
          items.set(result.items.filter(retained));
      })
      .catch(() => {});
  });
  return items;
}

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
  summaries: SourceSummary[];
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
  const { providers, accounts } = useModelSources();
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
  const monthly = (item: LlmConnection) => {
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
    const value = match.value?.monthly;
    return value && (!value.resetsAt || Date.parse(value.resetsAt) > now())
      ? value
      : undefined;
  };
  const usedText = (used: number) =>
    uiText("modelMonthlyUsed", { percent: percentText(used) });
  const amounts = (item: ProviderSummary) => {
    const match = props.summaries.find(
      (s) => s.source === "provider" && s.id === item.id,
    );
    return item.balanceRevision &&
      match?.source === "provider" &&
      match.balanceRevision === item.balanceRevision
      ? (match.value?.balance.lines.map(
          (line) =>
            `${line.currency} ${/^-?0+(?:\.0+)?$/.test(line.available) ? "0.00" : line.available}`,
        ) ?? [])
      : [];
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
                  style={
                    narrow()
                      ? { alignItems: "flex-start", gap: space[4] }
                      : { ...row, flexWrap: "wrap", columnGap: space[8], rowGap: space[2] }
                  }
                >
                  <Label variant="small" tone="muted">
                    {modelCount(item())}
                  </Label>
                  <If when={monthly(item())}>
                    {(value) => (
                      <View style={{ ...row, gap: space[4], maxWidth: "100%" }}>
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
                          {usedText(value().usedPercent)}
                        </Label>
                      </View>
                    )}
                  </If>
                </View>
                <If when={monthly(item())?.resetsAt}>
                  {(time) => (
                    <Label variant="small" tone="muted">
                      {uiText("modelQuotaResetsAt", {
                        time: localTime(time()),
                      })}
                    </Label>
                  )}
                </If>
                </If>
              </View>
            }
            wideMeta={props.phone}
            status={accountStatus(item())}
            accessibilityLabel={[
              item().label,
              item().connector,
              item().state,
              monthly(item()) && usedText(monthly(item())!.usedPercent),
              monthly(item())?.resetsAt &&
                uiText("modelQuotaResetsAt", {
                  time: localTime(monthly(item())?.resetsAt),
                }),
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
            meta={
              <View
                style={
                  narrow()
                    ? { alignItems: "flex-start", gap: 6 }
                    : {
                        ...row,
                        alignItems: "flex-start",
                        gap: props.phone ? 16 : 10,
                      }
                }
              >
                <Label variant="small" tone="muted">
                  {uiText("sourceModelCount", { count: item().models.length })}
                </Label>
                <If when={amounts(item()).length}>
                  <View
                    style={{
                      ...(narrow()
                        ? { alignItems: "flex-start" as const }
                        : { ...row, flex: 1 }),
                      minWidth: 0,
                      flexWrap: "wrap",
                      columnGap: 8,
                      rowGap: narrow() ? 6 : 2,
                    }}
                  >
                    <Each of={amounts(item())}>
                      {(amount) => (
                        <Label variant="small" tone="muted">
                          {amount()}
                        </Label>
                      )}
                    </Each>
                  </View>
                </If>
              </View>
            }
            wideMeta={props.phone}
            accessibilityLabel={[
              providerLabel(item()),
              ...amounts(item()),
            ].join(" · ")}
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
