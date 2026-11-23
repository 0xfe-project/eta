import type {
  BalanceLine,
  ProviderBalance,
  ProvidersView,
  SourceSummary,
} from "@eta/client-contracts";
import type { EtaProviderConfig } from "./config-types";
import type { ProviderConfigStore } from "./store";
import { billingRetryAt, modelSource } from "@eta/client-contracts";

import pLimit from "p-limit";
import { balanceRevision } from "./config-types";

const HISTORY_MS = 30 * 60_000;
const COOLDOWN_MS = 15_000;
type Currency = BalanceLine["currency"];
type ProviderSummary = Extract<SourceSummary, { source: "provider" }>;

interface Sample {
  lines: BalanceLine[];
  observedAt: string;
  partial: boolean;
  failedCurrencies?: Currency[];
}

interface Entry {
  bindings: Map<string, string>;
  abort: AbortController;
  next: number;
  failures: number;
  state: ProviderBalance["state"];
  sample?: Sample | undefined;
  reading?: Promise<ProviderBalance> | undefined;
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function amount(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return value;
  // A JSON number can use exponent notation. Expand its decimal digits without rounding.
  const match = /^(-?)(\d+)(?:\.(\d+))?e([+-]?\d+)$/i.exec(value);
  if (!match) return undefined;
  const [, sign, whole = "", fraction = "", exponent] = match;
  const point = whole.length + Number(exponent);
  if (Math.abs(point) > 256) return undefined;
  const digits = whole + fraction;
  if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) return sign + digits.padEnd(point, "0");
  return `${sign + digits.slice(0, point)}.${digits.slice(point)}`;
}

function amounts(
  body: unknown,
  kind: EtaProviderConfig["kind"],
): Omit<Sample, "observedAt"> {
  if (kind !== "deepseek") {
    const envelope = object(body);
    const available =
      envelope.status === true && envelope.code === 0
        ? amount(object(envelope.data).available_balance)
        : undefined;
    return {
      lines:
        available === undefined
          ? []
          : [{ currency: kind === "moonshot-cn" ? "CNY" : "USD", available }],
      partial: false,
    };
  }
  const rows = object(body).balance_infos;
  const totals = new Map<Currency, string | undefined>();
  let partial = false;
  for (const row of Array.isArray(rows) ? rows : []) {
    const { currency, total_balance: total } = object(row);
    if (currency !== "CNY" && currency !== "USD") {
      partial = true;
      continue;
    }
    const available = totals.has(currency) ? undefined : amount(total);
    totals.set(currency, available);
    if (available === undefined) partial = true;
  }
  const failedCurrencies = Array.from(totals).flatMap(([currency, total]) =>
    total === undefined ? [currency] : [],
  );
  return {
    ...(failedCurrencies.length ? { failedCurrencies } : {}),
    lines: Array.from(totals).flatMap(([currency, available]) =>
      available === undefined ? [] : [{ currency, available }],
    ),
    partial,
  };
}

function lookup(
  provider: EtaProviderConfig,
): { endpoint: string } | { state: ProviderBalance["state"] } {
  const official = modelSource(provider.kind)?.baseUrl;
  if (!official || provider.baseUrl.replace(/\/+$/, "") !== official)
    return { state: "unsupported" };
  if (
    [
      "commandcode",
      "opencode",
      "opencode-go",
      "zai-coding-cn",
      "zai",
      "kimi-coding",
    ].includes(provider.kind ?? "")
  )
    return { state: "spend_only" };
  if (provider.kind === "openrouter") return { state: "forbidden" };
  if (
    provider.kind !== "deepseek" &&
    provider.kind !== "moonshot-cn" &&
    provider.kind !== "moonshot-global"
  )
    return { state: "unsupported" };
  // Headers can replace authentication or select a different billing subject.
  if (Object.keys(provider.headers ?? {}).length) return { state: "forbidden" };
  if (!provider.apiKey?.trim()) return { state: "missing_key" };
  return {
    endpoint:
      official +
      (provider.kind === "deepseek" ? "/user/balance" : "/users/me/balance"),
  };
}

/** A plugin instance owns its Host's cache. The config revision fences credentials and deletions. */
export class ProviderBalances {
  readonly #entries = new Map<string, Entry>();
  readonly #store: ProviderConfigStore;
  readonly #request: typeof fetch;
  readonly schedule = pLimit(4);
  readonly #warn: (message: string) => void;
  constructor(
    store: ProviderConfigStore,
    request: typeof fetch = fetch,
    warn = console.warn,
  ) {
    this.#store = store;
    this.#request = request;
    this.#warn = warn;
  }

  invalidate(view?: ProvidersView): void {
    const revisions = new Map(
      view?.providers.map((item) => [item.id, item.balanceRevision]),
    );
    for (const [key, entry] of this.#entries) {
      for (const [id, revision] of entry.bindings) {
        if (revisions.get(id) !== revision) entry.bindings.delete(id);
      }
      if (entry.bindings.size) continue;
      entry.abort.abort();
      this.#entries.delete(key);
    }
  }

  async read(id: string, refresh: boolean): Promise<ProviderBalance> {
    const provider = (await this.#store.read()).config.providers?.find(
      (item) => item.id === id,
    );
    if (!provider) return { state: "unsupported" };
    const result = await this.#read(provider, refresh ? "refresh" : "cached");
    const current = (await this.#store.read()).config.providers?.find(
      (item) => item.id === id,
    );
    return current && balanceRevision(current) === balanceRevision(provider)
      ? result
      : { state: "unavailable" };
  }

  async summaryReads(): Promise<Promise<ProviderSummary>[]> {
    const providers = (await this.#store.read()).config.providers ?? [];
    return providers.map(async (provider) => {
      const revision = balanceRevision(provider);
      const result = await this.#read(provider, "fresh").catch(() => {
        this.#warn(
          `[eta-server] billing provider=${revision.slice(0, 12)} failure=unavailable`,
        );
        return undefined;
      });
      return {
        source: "provider" as const,
        id: provider.id,
        balanceRevision: revision,
        value:
          result?.state === "available" && result.lines?.length
            ? { balance: { lines: result.lines } }
            : null,
      };
    });
  }

  async currentSummary(item: ProviderSummary): Promise<ProviderSummary> {
    const current = (await this.#store.view()).providers.find(
      (provider) => provider.id === item.id,
    );
    return current?.balanceRevision === item.balanceRevision
      ? item
      : { ...item, value: null };
  }

  async summaries(): Promise<ProviderSummary[]> {
    const items = await Promise.all(await this.summaryReads());
    const current = (await this.#store.view()).providers;
    const revisions = new Map(
      current.map((item) => [item.id, item.balanceRevision]),
    );
    return items.map((item) =>
      revisions.get(item.id) === item.balanceRevision
        ? item
        : { ...item, value: null },
    );
  }

  async #read(
    provider: EtaProviderConfig,
    mode: "fresh" | "refresh" | "cached",
  ): Promise<ProviderBalance> {
    const capability = lookup(provider);
    if ("state" in capability) return capability;
    // Two configured names for the same official endpoint and credential share its in-flight
    // request and retry policy. The public row revision still includes its own id.
    const key = balanceRevision({
      ...provider,
      id: "",
      baseUrl: capability.endpoint,
      headers: {},
    });
    const entry: Entry = this.#entries.get(key) ?? {
      bindings: new Map(),
      next: 0,
      failures: 0,
      state: "query",
      abort: new AbortController(),
    };
    entry.bindings.set(provider.id, balanceRevision(provider));
    this.#entries.set(key, entry);
    if (entry.reading) return entry.reading;
    if (
      mode === "cached" ||
      (Date.now() < entry.next &&
        !(mode === "fresh" && entry.state === "available")) ||
      entry.state === "forbidden" ||
      entry.state === "invalid_key"
    )
      return this.#view(entry);
    entry.reading = this.schedule(() =>
      this.#query(entry, provider, capability.endpoint),
    ).finally(() => {
      entry.reading = undefined;
    });
    return entry.reading;
  }

  #view(entry: Entry): ProviderBalance {
    if (
      entry.sample &&
      Date.now() - Date.parse(entry.sample.observedAt) >= HISTORY_MS
    ) {
      entry.sample = undefined;
      if (entry.state === "available") entry.state = "query";
    }
    return {
      state: entry.state,
      ...entry.sample,
      ...(entry.next > Date.now()
        ? { retryAt: new Date(entry.next).toISOString() }
        : {}),
    };
  }

  async #query(
    entry: Entry,
    provider: EtaProviderConfig,
    endpoint: string,
  ): Promise<ProviderBalance> {
    entry.next = Date.now() + COOLDOWN_MS;
    let failure = "unavailable";
    const timeout = AbortSignal.timeout(15_000);
    try {
      const response = await this.#request(endpoint, {
        headers: {
          Authorization: `Bearer ${provider.apiKey}`,
          Accept: "application/json",
        },
        redirect: "error",
        signal: AbortSignal.any([entry.abort.signal, timeout]),
      });
      if (response.status === 401 || response.status === 403) {
        entry.state = response.status === 401 ? "invalid_key" : "forbidden";
        entry.sample = undefined;
      } else if (response.status === 429) {
        const header = response.headers.get("Retry-After")?.trim();
        entry.next = Math.max(
          entry.next,
          billingRetryAt(header, entry.failures++, Date.now()),
        );
        entry.state = "rate_limited";
      } else {
        failure = response.ok ? "invalid_response" : `http_${response.status}`;
        if (!response.ok) throw new Error("balance");
        // Preserve numeric JSON money as its source decimal, before binary64 rounding.
        const data: unknown = JSON.parse(
          await response.text(),
          (key: string, value: unknown, context?: { source?: string }) =>
            key === "available_balance" && typeof value === "number"
              ? context?.source
              : value,
        );
        const sample = amounts(data, provider.kind);
        if (!sample.lines.length) throw new Error("balance");
        entry.sample = { ...sample, observedAt: new Date().toISOString() };
        entry.state = "available";
        entry.failures = 0;
      }
    } catch {
      entry.state = timeout.aborted ? "timeout" : "unavailable";
      entry.next = Date.now() + COOLDOWN_MS;
    }
    if (entry.abort.signal.aborted) return { state: "unavailable" };
    if (entry.state !== "available" || entry.sample?.partial) {
      const reason =
        entry.state === "available"
          ? "partial_response"
          : entry.state === "unavailable"
            ? failure
            : entry.state;
      const retry =
        entry.state === "forbidden" || entry.state === "invalid_key"
          ? "credential_change"
          : new Date(entry.next).toISOString();
      this.#warn(
        `[eta-server] billing ${provider.kind} source=${balanceRevision(provider).slice(0, 12)} failure=${reason} retry=${retry}`,
      );
    }
    return this.#view(entry);
  }
}
