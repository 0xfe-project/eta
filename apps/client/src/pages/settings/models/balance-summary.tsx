import type {
  BalanceLine,
  ProviderBalance,
  ProvidersView,
} from "@eta/client-contracts";
import { announce, cleanup, computed, effect, signal, View } from "nsh";
import { Button, Label } from "../../../components";
import { space } from "../../../components/tokens";
import { uiText } from "../../../i18n";
import { useHost } from "../../../services/host";
import { billingClock, localTime } from "./quota";

const messages = {
  missing_key: "modelReadMissingKey",
  timeout: "modelReadFailed",
  invalid_key: "modelReadInvalidKey",
  forbidden: "modelReadForbidden",
  unavailable: "modelReadFailed",
  spend_only: "modelReadSpendOnly",
  unsupported: "modelReadUnsupported",
} as const;

function moneyText(value: string): string {
  if (/^-?0+(?:\.0+)?$/.test(value)) return "0.00";
  if (/^0+\.00/.test(value)) return `<0.01 (${value})`;
  if (/^-0+\.00/.test(value)) return `>−0.01 (${value})`;
  return value;
}

function balanceLabel(line: BalanceLine): string {
  return `${uiText("modelBalanceAvailable")} · ${line.currency} ${moneyText(line.available)}`;
}

export function BalanceSummary(props: { id: string }) {
  const host = useHost();
  const now = billingClock();
  const supported = computed(() => host.can("providers.readBalance"));
  const identity = computed(() =>
    JSON.stringify([
      host.address()?.origin,
      host.state().status,
      props.id,
      host
        .section<ProvidersView>("providers", "config")
        ?.providers.find((item) => item.id === props.id)?.balanceRevision ??
        host.section<ProvidersView>("providers", "config")?.revision,
    ]),
  );
  const online = computed(() => host.state().status === "open");
  const result = signal<{ key: string; value: ProviderBalance }>();
  const value = () =>
    result()?.key === identity() ? result()?.value : undefined;
  const busy = signal(false);
  let generation = 0;
  const state = () => value()?.state;
  const canQuery = () =>
    supported() &&
    ["available", "query", "rate_limited", "timeout", "unavailable"].includes(
      state() ?? "",
    );
  const age = () => now() - Date.parse(value()?.observedAt ?? "");
  const status = () => {
    if (!supported()) return uiText("modelReadHostUnsupported");
    const code = state();
    if (!code) return uiText("modelReadLoading");
    if (code === "rate_limited")
      return uiText("modelReadLimited", { time: localTime(value()?.retryAt) });
    if (code === "query" || code === "available") return "";
    return uiText(messages[code]);
  };
  async function read(key: string, refresh: boolean) {
    const turn = ++generation;
    busy.set(true);
    let next: ProviderBalance;
    try {
      next = await host.call<ProviderBalance>("providers", "readBalance", {
        id: props.id,
        refresh,
      });
    } catch {
      next = { state: "unavailable" };
    }
    if (generation === turn && key === identity()) {
      result.set({ key, value: next });
      busy.set(false);
      if (refresh) {
        const source = host
          .section<ProvidersView>("providers", "config")
          ?.providers.find((item) => item.id === props.id);
        announce(
          [
            source?.name ?? source?.id,
            ...(next.lines ?? []).map((line) => balanceLabel(line)),
            next.partial ? uiText("modelReadPartial") : "",
            status(),
          ]
            .filter(Boolean)
            .join(". "),
        );
      }
    }
  }
  effect(() => {
    const key = identity();
    if (supported() && online()) void read(key, false);
    cleanup(() => {
      generation++;
    });
  });
  return (
    <View
      android={{ accessibilityLiveRegion: "polite" }}
      style={{
        gap: space[2],
        paddingHorizontal: space[16],
        paddingVertical: space[8],
        alignItems: "flex-start",
      }}
    >
      <If when={age() < 1_800_000}>
        <Each of={value()?.lines ?? []} key={(item) => item.currency}>
          {(line) => (
            <View role="text" accessibilityLabel={balanceLabel(line())}>
              <Label variant="small">{balanceLabel(line())}</Label>
            </View>
          )}
        </Each>
        <If when={age() >= 300_000 || state() !== "available"}>
          <Label variant="small" tone="muted">
            {uiText("modelReadLastSuccess", {
              time: localTime(value()?.observedAt),
            })}
          </Label>
        </If>
      </If>
      <If when={value()?.partial && age() < 1_800_000}>
        <Label variant="small" tone="warning">
          {[value()?.failedCurrencies?.join(", "), uiText("modelReadPartial")]
            .filter(Boolean)
            .join(" · ")}
        </Label>
      </If>
      <If when={status()}>
        <Label variant="small" tone="muted">
          {status()}
        </Label>
      </If>
      <If when={canQuery()}>
        <Label variant="small" tone="muted">
          {uiText("modelBalanceQueryFeeUnknown")}
        </Label>
        <Button
          label={uiText(
            busy()
              ? "modelReadLoading"
              : value()?.observedAt
                ? "modelRefreshBalance"
                : "modelQueryBalance",
          )}
          disabled={busy() || Date.parse(value()?.retryAt ?? "") > now()}
          onPress={() => void read(identity(), true)}
        />
      </If>
    </View>
  );
}
