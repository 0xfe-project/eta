import type {
  LlmAccounts,
  LlmConnection,
  LlmModel,
  LlmQuota,
} from "@eta/client-contracts";
import { signal, View } from "nsh";
import {
  Button,
  colors,
  grow,
  Label,
  row,
  SmoothScroll,
} from "../../../components";
import { weight } from "../../../components/tokens";
import { uiText } from "../../../i18n";
import { useHost } from "../../../services/host";
import { LetterBox, PaneBack, SectionHeader } from "../section";
import { logoKey, useSourceLogos } from "./logos";
import {
  accountQuota,
  billingClock,
  currentPercent,
  localTime,
  monthlyWindows,
  percentText,
} from "./quota";

function MonthlyAccount(props: {
  title: string;
  account: LlmConnection;
  quota?: LlmQuota;
  now: number;
}) {
  const windows = () => monthlyWindows(props.quota);
  const problem = () => {
    if (props.account.state === "disabled") return uiText("modelReadDisabled");
    if (props.account.connector === "gemini")
      return uiText("modelReadSpendOnly");
    if (!props.quota) return uiText("modelQuotaUnknown");
    switch (props.quota.error?.code) {
      case "invalid_api_key":
        return uiText("modelReadInvalidKey");
      case "login_expired":
        return uiText("modelReadSignIn");
      case "no_token":
        return uiText("modelReadMissingKey");
      case "model_forbidden":
        return uiText("modelReadForbidden");
      case "rate_limited":
        return props.quota.retryAt || props.account.retryAt
          ? uiText("modelReadLimited", {
              time: localTime(props.quota.retryAt ?? props.account.retryAt),
            })
          : uiText("modelReadLimitedUnknown");
      case undefined:
        return windows().length
          ? ""
          : uiText(
              props.quota.windows.length
                ? "modelQuotaNoMonthly"
                : "modelQuotaNoWindows",
            );
      default:
        return uiText("modelReadFailed");
    }
  };
  const title = () =>
    [props.title, props.quota?.plan || props.account.plan]
      .filter(Boolean)
      .join(" · ");
  return (
    <View android={{ accessibilityLiveRegion: "polite" }} style={{ gap: 2 }}>
      <If
        when={problem()}
        else={
          <Each of={windows()} key="index">
            {(window) => {
              const used = () =>
                currentPercent(props.quota!, window(), props.now);
              const usage = () =>
                used() === undefined
                  ? uiText(
                      Date.parse(window().resetsAt ?? "") <= props.now
                        ? "modelQuotaElapsed"
                        : "modelQuotaUnknown",
                    )
                  : uiText("modelQuotaUsed", { percent: percentText(used()!) });
              return (
                <View style={{ gap: 2 }}>
                  <Label variant="small">{`${title()} · ${uiText("modelQuotaMonthly")} · ${usage()}`}</Label>
                  <Label variant="small" tone="muted">
                    {localTime(window().resetsAt)
                      ? uiText("modelQuotaResetsAt", {
                          time: localTime(window().resetsAt),
                        })
                      : uiText("modelQuotaResetUnknown")}
                  </Label>
                  <If
                    when={
                      used() !== undefined &&
                      props.now - Date.parse(props.quota?.observedAt ?? "") >=
                        600_000
                    }
                  >
                    <Label variant="small" tone="muted">
                      {uiText("modelReadLastSuccess", {
                        time: localTime(props.quota?.observedAt),
                      })}
                    </Label>
                  </If>
                </View>
              );
            }}
          </Each>
        }
      >
        <Label variant="small">{title()}</Label>
        <Label variant="small" tone="muted">
          {problem()}
        </Label>
      </If>
    </View>
  );
}

export function SubscriptionDetail(props: {
  connector: string;
  phone: boolean;
  onClose: () => void;
}) {
  const host = useHost();
  const c = colors();
  const now = billingClock();
  const logo = useSourceLogos();
  const tab = signal<"models" | "connection">("models");
  const busy = signal(false);
  const failed = signal(false);
  const accounts = () => host.section<LlmAccounts>("llm", "accounts");
  const connections = () =>
    accounts()?.connections.filter(
      (item) => item.connector === props.connector,
    ) ?? [];
  const quota = () => host.section<LlmQuota[]>("llm", "quota");
  const models = () =>
    host
      .list<LlmModel>("llm", "models")
      .filter((item) => item.connector === props.connector);
  const name = () =>
    accounts()?.connectors.find((item) => item.id === props.connector)?.name ??
    props.connector;
  async function refresh() {
    if (busy()) return;
    busy.set(true);
    failed.set(false);
    try {
      await host.call("llm", "refresh", {});
    } catch {
      failed.set(true);
    } finally {
      busy.set(false);
    }
  }
  const summary = () => (
    <View
      style={{
        paddingHorizontal: 16,
        paddingVertical: 8,
        gap: 4,
        alignItems: "flex-start",
      }}
    >
      <Each of={connections()} key={(item) => item.id}>
        {(account) => (
          <MonthlyAccount
            account={account()}
            title={
              connections().filter((item) => item.label === account().label)
                .length > 1
                ? `${account().label} (${account().id})`
                : account().label
            }
            quota={accountQuota(quota(), account())}
            now={now()}
          />
        )}
      </Each>
      <If when={failed()}>
        <Label variant="small" tone="warning">
          {uiText("modelReadFailed")}
        </Label>
      </If>
      <If when={props.connector !== "gemini"}>
        <Button
          label={uiText(busy() ? "modelReadLoading" : "modelRefreshQuota")}
          disabled={
            busy() || !connections().some((item) => item.state !== "disabled")
          }
          onPress={() => void refresh()}
        />
      </If>
    </View>
  );
  return (
    <View style={grow}>
      <SectionHeader
        title={name()}
        leading={
          <>
            <PaneBack onPress={props.onClose} />
            <If when={props.phone}>
              <LetterBox
                name={name()}
                logo={logo(logoKey.connector(props.connector))}
              />
            </If>
          </>
        }
        phone={props.phone}
      />
      <SmoothScroll style={grow} scrollbar={false}>
        <If when={!props.phone}>{summary()}</If>
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
                  weight={
                    tab() === item()
                      ? props.phone
                        ? weight.strong
                        : weight.regular
                      : weight.regular
                  }
                  tone={
                    tab() === item()
                      ? "ink"
                      : props.phone
                        ? "mutedInk"
                        : "muted"
                  }
                >
                  {item() === "models"
                    ? uiText("models2")
                    : uiText("sourceConnectionTab")}
                </Label>
                <If when={item() === "models" && !props.phone}>
                  <Label variant="small" tone="muted">
                    {models().length}
                  </Label>
                </If>
              </View>
            )}
          </Each>
        </View>
        <If
          when={tab() === "models"}
          else={
            <Each of={connections()} key={(item) => item.id}>
              {(item) => (
                <Label
                  style={{ padding: 16 }}
                >{`${item().label} · ${item().state}`}</Label>
              )}
            </Each>
          }
        >
          <If when={props.phone}>{summary()}</If>
          <Label
            weight={weight.strong}
            style={{ padding: 16 }}
          >{`${uiText("models2")} ${models().length}`}</Label>
          <Each of={models()} key={(item) => item.id}>
            {(model) => (
              <Label style={{ paddingHorizontal: 16, paddingVertical: 8 }}>
                {model().name}
              </Label>
            )}
          </Each>
        </If>
      </SmoothScroll>
    </View>
  );
}
