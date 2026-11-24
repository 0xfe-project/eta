import type {
  SourceSummaryEvent,
  SourceSummaryUpdate,
} from "@eta/client-contracts";
import type { HostAddress } from "../../../services/host";
import { cleanup, computed, effect, signal, untracked } from "nsh";
import { useHost } from "../../../services/host";
import { useModelSources } from "./source-list";

export type DisplayedSourceSummary = SourceSummaryUpdate & {
  previousAt?: number;
};

interface Observation {
  summary: SourceSummaryUpdate;
  visitId: string;
  at: number;
}

function summaryHistory(address: HostAddress | null) {
  return { address, values: signal<Observation[]>([]) };
}

// A closed Settings pane can be reopened on the same Host.
const histories = new WeakMap<
  ReturnType<typeof useHost>,
  ReturnType<typeof summaryHistory>
>();
let nextVisit = 0;

function key(summary: SourceSummaryUpdate) {
  return `${summary.source}:${summary.id}` as const;
}

function revision(summary: SourceSummaryUpdate) {
  return summary.source === "provider"
    ? summary.balanceRevision
    : summary.quotaRevision;
}

/** The Settings pane owns the visit across responsive layouts and detail pages. */
export function useSourceSummaries(visible: () => boolean) {
  const host = useHost();
  const { providers, accounts, count } = useModelSources();
  const history =
    histories.get(host) ?? summaryHistory(untracked(host.address));
  histories.set(host, history);
  const shownVisit = signal<string>();
  const connected = computed(
    () =>
      host.state().status === "open" &&
      host.can("billing.startSourceSummaries"),
  );
  const revisions = computed(
    () =>
      new Map([
        ...providers().map(
          (item) => [`provider:${item.id}`, item.balanceRevision] as const,
        ),
        ...accounts().map(
          (item) =>
            [
              `account:${item.id}`,
              item.state === "active" ? item.quotaRevision : undefined,
            ] as const,
        ),
      ]),
  );

  let requested = false;
  let end: ((clearPending: boolean) => void) | undefined;
  let trackRevisions:
    | ((current: ReturnType<typeof revisions>) => void)
    | undefined;
  let currentWire = untracked(host.subscriptionWire);

  cleanup(() => end?.(false));
  effect(() => {
    const current = revisions();
    trackRevisions?.(current);
    const values = untracked(history.values);
    const retained = values.filter(
      ({ summary }) => current.get(key(summary)) === revision(summary),
    );
    if (retained.length !== values.length) history.values.set(retained);
  });

  effect(() => {
    const address = host.address();
    const wire = host.subscriptionWire();
    const showing = visible();
    const online = connected();
    if (history.address !== address) {
      end?.(false);
      history.address = address;
      history.values.set([]);
      requested = false;
    }
    if (currentWire !== wire) {
      end?.(true);
      currentWire = wire;
    }
    if (!showing) {
      end?.(false);
      requested = false;
      return;
    }
    if (!online) {
      // Losing the socket ends this visit. A reconnect alone is not a new list entry.
      end?.(true);
      return;
    }
    if (requested) return;
    requested = true;

    const visitId = `${Date.now()}-${++nextVisit}`;
    shownVisit.set(visitId);
    const timeout = 30_000 + 15_000 * Math.ceil(untracked(count) / 4);
    const deadline = Date.now() + timeout;
    let previous = untracked(revisions);
    const retired = new Set<string>();
    trackRevisions = (current) => {
      for (const [id, version] of previous) {
        if (version && current.get(id) !== version) retired.add(id);
      }
      previous = current;
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;
    const finish = (clearPending = true) => {
      if (end !== finish) return;
      end = undefined;
      trackRevisions = undefined;
      clearTimeout(timer);
      unsubscribe?.();
      if (clearPending)
        history.values.update((values) =>
          values.filter((item) => item.visitId === visitId),
        );
    };
    unsubscribe = host.onEvent("billing", ({ name, data }) => {
      if (
        end !== finish ||
        untracked(host.address) !== address ||
        untracked(host.subscriptionWire) !== wire ||
        !untracked(visible) ||
        !untracked(connected) ||
        !data ||
        typeof data !== "object" ||
        (data as Partial<SourceSummaryEvent>).visitId !== visitId
      )
        return;
      if (name === "sourceSummariesDone" || Date.now() >= deadline) {
        finish(true);
        return;
      }
      if (name !== "sourceSummary") return;
      const { visitId: _, ...summary } = data as SourceSummaryEvent;
      const id = key(summary);
      const version = revision(summary);
      if (
        !version ||
        retired.has(id) ||
        untracked(revisions).get(id) !== version
      )
        return;
      history.values.update((values) => {
        const remaining = values.filter((item) => key(item.summary) !== id);
        if (summary.value !== null)
          remaining.push({ summary, visitId, at: Date.now() });
        return remaining;
      });
    });
    timer = setTimeout(finish, timeout);
    end = finish;
    void host
      .call("billing", "startSourceSummaries", { visitId })
      .catch(() => finish(true));
  });

  return (): DisplayedSourceSummary[] => {
    const values = history.values();
    if (history.address !== host.address()) return [];
    return values.map(({ summary, visitId, at }) =>
      visitId === shownVisit() ? summary : { ...summary, previousAt: at },
    );
  };
}
