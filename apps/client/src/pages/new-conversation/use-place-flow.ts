import type {
  CloneView,
  FlowPage,
  MachineView,
  PlaceFailure,
  PlaceListing,
  PlaceMatch,
  PlaceRef,
  PlacesAction,
  PlacesArgs,
  PlacesResults,
  RecentPlace,
} from "@eta/client-contracts";
import type { ChoiceRow } from "./place-choices";
import {
  chooseNewParent,
  clampActive,
  currentPage,
  openFlow,
  setMachines,
} from "@eta/client-contracts";
import { cleanup, computed, effect, signal } from "nsh";
import { localizedText } from "../../i18n";
import { follow, useHost } from "../../services/host";
import { placeChoices } from "./place-choices";
import { placeFailure } from "./place-errors";

export interface DirectoryChoice extends PlaceRef {
  machineId: string;
  name?: string;
  projectId?: string | null;
}

export function usePlaceFlow() {
  const host = useHost();
  follow(() => "machines");
  follow(() => "places");
  const machines = () =>
    host
      .list<MachineView>("machines")
      .filter((machine) => machine.status !== "pending");
  const flow = signal(openFlow({ machines: machines() }));
  effect(() => {
    const values = machines();
    flow.update((state) => setMachines(state, values));
  });
  const page = () => currentPage(flow());
  const machineId = computed(() => {
    const current = page();
    return current.kind === "machine" ? undefined : current.machineId;
  });
  const machine = () => machines().find((entry) => entry.id === machineId());
  const machineName = () => machine()?.name ?? localizedText("Machine", "机器");
  const directory = signal<DirectoryChoice | undefined>(undefined);
  const busy = signal(false);
  const error = signal<PlaceFailure | undefined>(undefined);
  const clone = signal<CloneView | undefined>(undefined);
  const cancelling = signal(false);

  function place<K extends PlacesAction>(op: K, args: PlacesArgs[K]) {
    return host.call<PlacesResults[K]>("places", op, args);
  }

  const capabilities = signal<PlacesResults["capabilities"] | undefined>(
    undefined,
  );
  const capabilitiesAvailable = computed(() => host.can("places.capabilities"));
  effect(() => {
    const id = machineId();
    capabilities.set(undefined);
    if (!id || !capabilitiesAvailable()) return;
    let current = true;
    void place("capabilities", { machineId: id }).then(
      (value) => {
        if (current) capabilities.set(value);
      },
      (failure: unknown) => {
        if (current) error.set(placeFailure(failure));
      },
    );
    cleanup(() => {
      current = false;
    });
  });

  const listing = signal<PlaceListing | undefined>(undefined);
  const matches = signal<PlaceMatch[]>([]);
  const repositories = signal<PlacesResults["repos"] | undefined>(undefined);
  const loading = signal(false);
  const query = computed(() => page().query.trim());
  const kind = computed(() => page().kind);
  const browsePath = computed(() => {
    const current = page();
    return current.kind === "browse" ? current.path : null;
  });
  const canBrowse = computed(() => host.can("places.list"));
  const canSearch = computed(() => host.can("places.search"));
  const canSearchGitHub = computed(
    () => capabilities()?.gh === "ready" && host.can("places.repos"),
  );
  let lastContext = "";
  effect(() => {
    const id = machineId();
    const mode = kind();
    const filter = mode === "browse" ? "" : query();
    const path = mode === "browse" ? browsePath() : null;
    const githubSearch = mode === "github" && canSearchGitHub();
    const contextKey = `${id ?? ""}:${mode}`;
    if (contextKey !== lastContext) {
      lastContext = contextKey;
      listing.set(undefined);
      matches.set([]);
      repositories.set(undefined);
    } else if (!filter && mode !== "browse" && !githubSearch) {
      matches.set([]);
    }
    loading.set(false);
    if (!id) return;
    const browsing = mode === "browse" && canBrowse();
    const searching =
      filter &&
      (mode === "search" ||
        mode === "clone-location" ||
        mode === "new-parent") &&
      canSearch();
    if (!browsing && !searching && !githubSearch) return;
    let current = true;
    loading.set(true);
    const timer = setTimeout(
      () => {
        const request = browsing
          ? place("list", { machineId: id, path: path ?? undefined }).then(
              (value) => {
                if (current) listing.set(value);
              },
            )
          : githubSearch
            ? place("repos", { machineId: id, query: filter }).then((value) => {
                if (current) repositories.set(value);
              })
            : place("search", { machineId: id, query: filter, limit: 40 }).then(
                (value) => {
                  if (current) matches.set(value.matches);
                },
              );
        void request
          .catch((failure: unknown) => {
            if (current) error.set(placeFailure(failure));
          })
          .finally(() => {
            if (current) loading.set(false);
          });
      },
      browsing ? 0 : 160,
    );
    cleanup(() => {
      current = false;
      clearTimeout(timer);
    });
  });

  function choose(
    id: string,
    place: PlaceRef & { projectId?: string | null; name?: string },
  ) {
    directory.set({ ...place, machineId: id });
    error.set(undefined);
  }

  async function perform<T>(
    request: () => Promise<T>,
    done: (result: T) => void,
  ) {
    if (busy()) return;
    busy.set(true);
    error.set(undefined);
    try {
      const result = await request();
      busy.set(false);
      done(result);
    } catch (failure) {
      busy.set(false);
      error.set(placeFailure(failure));
    }
  }

  async function cancelClone() {
    const active = clone();
    if (!active || cancelling() || !host.can("places.cancelClone")) return;
    cancelling.set(true);
    try {
      await place("cancelClone", { cloneId: active.id });
    } catch (failure) {
      error.set(placeFailure(failure));
    } finally {
      cancelling.set(false);
    }
  }

  const cloneProgress = () => {
    const active = clone();
    return (
      active &&
      (host
        .list<CloneView>("places", "clones")
        .find((entry) => entry.id === active.id) ??
        active)
    );
  };
  effect(() => {
    const active = cloneProgress();
    if (!active || active.status === "running") return;
    clone.set(undefined);
    if (active.status === "done") choose(active.machineId, active.target);
    else
      error.set(
        active.failure ?? {
          code: active.status === "cancelled" ? "cancelled" : "other",
        },
      );
  });

  function takeLocation(
    current: FlowPage,
    target: PlaceRef & { projectId?: string | null; name?: string },
  ) {
    if (current.kind === "machine") return;
    if (current.kind === "new-parent") {
      flow.update((state) => chooseNewParent(state, target));
    } else if (current.kind === "clone-location") {
      void perform(
        () =>
          place("clone", {
            machineId: current.machineId,
            url: current.repo.cloneUrl,
            protocol: current.repo.protocol,
            parent: target.path,
          }),
        (result) => clone.set(result.clone),
      );
    } else {
      choose(current.machineId, target);
    }
  }

  const recent = () =>
    host
      .list<RecentPlace>("places", "recent")
      .filter((entry) => entry.machineId === machineId());
  const rows = () =>
    placeChoices({
      page,
      capabilities,
      flow,
      machine,
      machineName,
      host,
      error,
      matches,
      query,
      listing,
      repositories,
      choose,
      perform,
      place,
      takeLocation,
      recent,
    });
  const options = () => rows().map((entry) => !entry.disabled);
  const selected = () => clampActive(page().activeIndex, options());
  function select(entry: ChoiceRow | undefined) {
    if (!busy() && !clone() && entry && !entry.disabled) {
      error.set(undefined);
      entry.select();
    }
  }
  return {
    cancelClone,
    cancelling,
    clone,
    cloneProgress,
    directory,
    error,
    flow,
    kind,
    listing,
    loading,
    machineId,
    machineName,
    options,
    page,
    place,
    query,
    rows,
    select,
    selected,
    busy,
  };
}
