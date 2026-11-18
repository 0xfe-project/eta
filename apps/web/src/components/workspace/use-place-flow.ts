import type {
  FlowMachine,
  FlowPage,
  FlowState,
  MachineView,
  MethodNote,
  PlaceFailure,
  PlaceListing,
  PlaceRef,
  RepoChoice,
} from "@eta/client-contracts";
import {
  back,
  buildSuggestions,
  childDisplay,
  chooseMachine,
  chooseMethod,
  chooseNewParent,
  chooseRepo,
  clampActive,
  currentPage,
  machineOptions,
  manualRepoChoices,
  methodOptions,
  moveActive,
  openBrowse,
  openFlow,
  parentsOf,
  PLACE_PROBLEMS,
  repoName,
  repoOptions,
  setActive,
  setBusy,
  setError,
  setMachines,
  setQuery,
  setShowHidden,
} from "@eta/client-contracts";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  capabilitiesQuery,
  listQuery,
  placesCall,
  reposQuery,
  resolvePlace,
  searchQuery,
  useClones,
  useRecentPlaces,
} from "@/queries/places";
import { useMachines } from "@/queries/projects";

/** Where the flow ends: a directory on a machine, as that machine writes it. */
export interface PlaceChoice {
  machineId: string;
  path: string;
  display: string;
}

/** A row of the current page, already worded. */
interface PlaceRow {
  key: string;
  /** The heading it sits under, when the page has more than one kind of row. */
  section?: string | undefined;
  label: string;
  detail?: string | undefined;
  tags: string[];
  disabled: boolean;
  /** Why it is greyed out, or what it is limited to. */
  note?: string | undefined;
  take: () => void;
}

const machinesOf = (machines: readonly MachineView[]): FlowMachine[] =>
  machines
    .filter(
      (machine) => machine.status !== "pending" && machine.status !== "revoked",
    )
    .map(({ id, name, kind, status }) => ({ id, name, kind, status }));

/** What was typed, a moment after the typing stopped. */
function useSettled(value: string, ms = 150): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(setSettled, ms, value);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/** A failure as the machine said it, or as the link did. */
function failureOf(error: unknown): PlaceFailure {
  const problem = (
    error as {
      problem?: { code?: unknown; params?: { detail?: unknown } };
    } | null
  )?.problem;
  const known = PLACE_PROBLEMS.find((code) => code === problem?.code);
  if (known !== undefined) {
    const detail = problem?.params?.detail;
    return typeof detail === "string"
      ? { code: known, detail }
      : { code: known };
  }
  return {
    code: "other",
    detail: error instanceof Error ? error.message : String(error),
  };
}

const machineIdOf = (page: FlowPage): string | undefined =>
  page.kind === "machine" ? undefined : page.machineId;

/**
 * Choosing a directory on a machine, as the shared flow (`@eta/client-contracts` `places/flow`)
 * says, with the web's queries behind it. The component that draws it only draws: the rows come
 * from here already worded, and Enter, the arrows and Escape go through `key`.
 */
export function usePlaceFlow(options: {
  /** Start on this machine; the machine page is skipped. */
  machineId?: string | undefined;
  onChoose: (choice: PlaceChoice) => void;
  /** The system's folder dialog, when this page has one for the primary. */
  nativeBrowse?: (() => Promise<string | null>) | undefined;
}) {
  const { t: translateText } = useTranslation("chat");
  const { machines } = useMachines();
  const flowMachines = useMemo(() => machinesOf(machines), [machines]);
  const [state, setState] = useState<FlowState>(() =>
    openFlow({ machines: flowMachines, machineId: options.machineId }),
  );
  const stateRef = useRef(state);
  stateRef.current = state;
  const update = (next: (state: FlowState) => FlowState) =>
    setState((now) => {
      const made = next(now);
      stateRef.current = made;
      return made;
    });

  useEffect(() => {
    update((now) => setMachines(now, flowMachines, options.machineId));
  }, [flowMachines, options.machineId]);

  const page = currentPage(state);
  const machineId = machineIdOf(page);
  const machine = machines.find((entry) => entry.id === machineId);
  const capabilities = useQuery({
    ...capabilitiesQuery(machineId ?? ""),
    enabled: machineId !== undefined,
  });
  const caps = capabilities.data;
  const flavor = caps?.flavor ?? (machine?.os === "win32" ? "win32" : "posix");
  const recentAll = useRecentPlaces();
  const recent = useMemo(
    () => recentAll.filter((place) => place.machineId === machineId),
    [recentAll, machineId],
  );
  const clones = useClones();

  const query = page.query;
  const settled = useSettled(query.trim());
  const searching =
    machineId !== undefined &&
    settled !== "" &&
    (page.kind === "search" ||
      page.kind === "new-parent" ||
      page.kind === "clone-location");
  const search = useQuery({
    ...searchQuery(machineId ?? "", settled),
    enabled: searching,
  });
  const browsing = page.kind === "browse" ? page : undefined;
  const listing = useQuery({
    ...listQuery(machineId ?? "", browsing?.path ?? null),
    enabled: browsing !== undefined,
  });
  // The last directory that could be listed: its crumbs stay up while one that cannot be is
  // shown, so there is a way back from it.
  const lastListedRef = useRef<PlaceListing | undefined>(undefined);
  if (listing.data !== undefined) lastListedRef.current = listing.data;
  const repos = useQuery({
    ...reposQuery(machineId ?? "", settled),
    enabled: page.kind === "github" && caps?.gh === "ready",
  });

  // The clone this flow started, as the host follows it; it is let go of once it has ended.
  const cloneIdRef = useRef<string | undefined>(undefined);
  const clone = clones.find((entry) => entry.id === cloneIdRef.current);
  const onChooseRef = useRef(options.onChoose);
  onChooseRef.current = options.onChoose;
  useEffect(() => {
    if (clone === undefined || clone.status === "running") return;
    cloneIdRef.current = undefined;
    if (clone.status === "done")
      onChooseRef.current({ machineId: clone.machineId, ...clone.target });
    else update((now) => setError(now, clone.failure ?? { code: "other" }));
  }, [clone]);

  const fail = (error: unknown) =>
    update((now) => setError(now, failureOf(error)));

  /** A path from a row: checked on the machine, then chosen. */
  const open = (target: string) => {
    if (machineId === undefined) return;
    update((now) => setBusy(now, true));
    resolvePlace(machineId, target).then((found) => {
      if (!found.exists) return fail(new PlaceProblem("not_found"));
      if (!found.directory) return fail(new PlaceProblem("not_directory"));
      update((now) => setBusy(now, false));
      onChooseRef.current({
        machineId,
        path: found.path,
        display: found.display,
      });
    }, fail);
  };

  const startClone = (repo: RepoChoice, parent: PlaceRef) => {
    if (machineId === undefined) return;
    update((now) => setBusy(now, true));
    placesCall("clone", {
      machineId,
      url: repo.cloneUrl,
      ...(repo.protocol === undefined ? {} : { protocol: repo.protocol }),
      parent: parent.path,
    }).then((started) => {
      cloneIdRef.current = started.clone.id;
    }, fail);
  };

  /** The way's own next step for a directory on the location pages. */
  const takeLocation = (place: PlaceRef) => {
    if (machineId === undefined) return;
    if (page.kind === "new-parent")
      update((now) => chooseNewParent(now, place));
    else if (page.kind === "clone-location") startClone(page.repo, place);
    else onChooseRef.current({ machineId, ...place });
  };

  const noteText = (note: MethodNote | undefined): string | undefined =>
    note === undefined
      ? undefined
      : translateText(`new.places.notes.${camelKey(note)}`);

  const rows: PlaceRow[] = (() => {
    switch (page.kind) {
      case "machine":
        return machineOptions(state.machines, page.query).map(
          ({ machine: entry, closed }) => ({
            key: entry.id,
            label: entry.name,
            detail: translateText(`new.places.machineKinds.${entry.kind}`),
            tags: [],
            disabled: closed !== undefined,
            note:
              closed === undefined
                ? undefined
                : translateText(`new.places.closed.${closed}`),
            take: () => update((now) => chooseMachine(now, entry.id)),
          }),
        );
      case "method": {
        const native =
          options.nativeBrowse !== undefined && machine?.kind === "primary";
        const needle = page.query.trim().toLowerCase();
        return methodOptions(caps, { nativeBrowse: native })
          .filter((option) =>
            translateText(`new.places.methods.${option.id}`)
              .toLowerCase()
              .includes(needle),
          )
          .map((option) => ({
            key: option.id,
            label: translateText(`new.places.methods.${option.id}`),
            detail:
              option.note === undefined
                ? translateText(`new.places.methodDetails.${option.id}`, {
                    name: machine?.name ?? "",
                  })
                : undefined,
            tags: [],
            disabled: option.disabled,
            note: noteText(option.note),
            take: () => {
              if (option.id === "browse" && native) {
                options.nativeBrowse!().then((picked) => {
                  if (picked !== null) open(picked);
                }, fail);
                return;
              }
              update((now) => chooseMethod(now, page.machineId, option.id));
            },
          }));
      }
      case "search":
      case "new-parent":
      case "clone-location": {
        const parents: PlaceRef[] =
          page.kind === "clone-location" && caps !== undefined
            ? [caps.cloneParent]
            : page.kind === "new-parent" && caps !== undefined
              ? [{ path: caps.home, display: "~" }]
              : [];
        const suggestions = buildSuggestions({
          query: page.query,
          flavor,
          os: machine?.os,
          recent:
            page.kind === "search"
              ? recent
              : [...parents, ...parentsOf(recent)],
          found:
            settled === page.query.trim() ? (search.data?.matches ?? []) : [],
        });
        const name =
          page.kind === "clone-location"
            ? repoName(page.repo.nameWithOwner)
            : undefined;
        return suggestions.map((suggestion) => {
          if (suggestion.kind === "typed") {
            return {
              key: `typed:${suggestion.path}`,
              section: translateText("new.places.sections.typed"),
              label: translateText("new.places.open", {
                path: suggestion.path,
              }),
              tags: [],
              disabled: false,
              take: () => {
                if (page.kind === "search") return open(suggestion.path);
                if (machineId === undefined) return;
                update((now) => setBusy(now, true));
                resolvePlace(machineId, suggestion.path).then((found) => {
                  if (!found.directory)
                    return fail(new PlaceProblem("not_found"));
                  update((now) => setBusy(now, false));
                  takeLocation({ path: found.path, display: found.display });
                }, fail);
              },
            };
          }
          const place = suggestion.place;
          const tags: string[] = [];
          if ("git" in place && place.git === true) tags.push("git");
          if ("projectId" in place && place.projectId !== null)
            tags.push(translateText("new.picker.added"));
          return {
            key: `${suggestion.kind}:${place.path}`,
            section: translateText(
              suggestion.kind === "recent"
                ? page.kind === "search"
                  ? "new.places.sections.recent"
                  : "new.places.sections.suggested"
                : "new.places.sections.found",
            ),
            label:
              name === undefined
                ? place.display
                : childDisplay(place, name, flavor),
            detail:
              name === undefined
                ? undefined
                : translateText("new.places.parentIs", { path: place.display }),
            tags,
            disabled: false,
            take: () =>
              takeLocation({ path: place.path, display: place.display }),
          };
        });
      }
      case "browse": {
        const listed = listing.data;
        if (listed === undefined) return [];
        const here: PlaceRow = {
          key: `here:${listed.path}`,
          label: translateText("new.places.useHere", { path: listed.display }),
          tags: [],
          disabled: false,
          take: () =>
            onChooseRef.current({
              machineId: page.machineId,
              path: listed.path,
              display: listed.display,
            }),
        };
        const needle = page.query.trim().toLowerCase();
        const entries = listed.entries.filter(
          (entry) =>
            (page.showHidden || !entry.hidden) &&
            entry.name.toLowerCase().includes(needle),
        );
        return [
          here,
          ...entries.map((entry) => ({
            key: entry.path,
            section: translateText("new.places.sections.inside"),
            label: entry.name,
            tags: [
              ...(entry.git ? ["git"] : []),
              ...(entry.projectId === null
                ? []
                : [translateText("new.picker.added")]),
            ],
            disabled: false,
            take: () =>
              update((now) => openBrowse(now, page.machineId, entry.path)),
          })),
        ];
      }
      case "github": {
        const typed = manualRepoChoices(page.query);
        const found = repos.data?.available === true ? repos.data.repos : [];
        return repoOptions(typed, found).map((repo) => ({
          key: repo.id,
          section: translateText(
            repo.id.startsWith("manual:")
              ? "new.places.sections.typedRepo"
              : "new.places.sections.repos",
          ),
          label: repo.nameWithOwner,
          detail:
            repo.protocol === undefined
              ? (repo.description ?? undefined)
              : translateText("new.places.via", {
                  protocol: repo.protocol.toUpperCase(),
                }),
          tags: [],
          disabled: false,
          take: () => update((now) => chooseRepo(now, repo)),
        }));
      }
      case "new-name": {
        const name = page.query.trim();
        if (name === "") return [];
        return [
          {
            key: `new:${name}`,
            label: translateText("new.places.create", {
              path: childDisplay(page.parent, name, flavor),
            }),
            tags: [],
            disabled: false,
            take: () => {
              update((now) => setBusy(now, true));
              placesCall("mkdir", {
                machineId: page.machineId,
                parent: page.parent.path,
                name,
              }).then((made) => {
                update((now) => setBusy(now, false));
                onChooseRef.current({ machineId: page.machineId, ...made });
              }, fail);
            },
          },
        ];
      }
    }
  })();

  const selectable = rows.map((row) => !row.disabled);
  const active = clampActive(page.activeIndex, selectable);

  /** What a key does on the page; true when it did something, so the caller can stop it there. */
  const key = (name: "ArrowDown" | "ArrowUp" | "Enter" | "Escape"): boolean => {
    if (name === "ArrowDown" || name === "ArrowUp") {
      update((now) =>
        moveActive(
          setActive(now, active),
          selectable,
          name === "ArrowDown" ? "next" : "previous",
        ),
      );
      return true;
    }
    if (name === "Enter") {
      if (page.busy) return true;
      const row = rows[active];
      if (row === undefined || row.disabled) return false;
      row.take();
      return true;
    }
    // Escape: a clone under way stops first; then one page back. On the first page it is the
    // caller's, which closes.
    if (cloneIdRef.current !== undefined) {
      void placesCall("cancelClone", { cloneId: cloneIdRef.current });
      return true;
    }
    const previous = back(stateRef.current);
    if (previous === null) return false;
    update(() => previous);
    return true;
  };

  /** What a person sees as the box's question on this page. */
  const placeholder = translateText(
    `new.places.placeholders.${camelKey(page.kind)}`,
  );
  const loading =
    (page.kind === "browse" && listing.isPending) ||
    (searching && search.isFetching) ||
    (page.kind === "github" && repos.isFetching) ||
    (page.kind === "method" && capabilities.isPending);
  const problem: PlaceFailure | null =
    page.error ??
    (page.kind === "browse" && listing.isError
      ? failureOf(listing.error)
      : null) ??
    (page.kind === "method" && capabilities.isError
      ? failureOf(capabilities.error)
      : null);

  return {
    state,
    page,
    machine,
    capabilities: caps,
    flavor,
    rows,
    active,
    listing: browsing === undefined ? undefined : listing.data,
    /** Where browsing is, as the machine breaks it up; the last place listed while this one fails. */
    crumbs:
      browsing === undefined
        ? undefined
        : (listing.data ?? lastListedRef.current),
    loading,
    problem,
    clone,
    placeholder,
    /** The box changed. */
    type: (value: string) => update((now) => setQuery(now, value)),
    point: (index: number) => update((now) => setActive(now, index)),
    key,
    walk: (path: string | null) => {
      if (machineId !== undefined)
        update((now) => openBrowse(now, machineId, path));
    },
    showHidden: (show: boolean) => update((now) => setShowHidden(now, show)),
    retry: () => {
      update((now) => setError(now, null));
      void listing.refetch();
      void capabilities.refetch();
    },
  };
}

export type PlaceFlow = ReturnType<typeof usePlaceFlow>;

/** `no_git` → `noGit`, `clone-location` → `cloneLocation`: the codes as translation keys. */
export function camelKey<T extends string>(code: T): CamelKey<T> {
  return code.replace(/[_-](\w)/g, (_, letter: string) =>
    letter.toUpperCase(),
  ) as CamelKey<T>;
}

type CamelKey<T extends string> =
  T extends `${infer Head}${"_" | "-"}${infer Tail}`
    ? `${Head}${CamelKey<Capitalize<Tail>>}`
    : T;

/** A failure the flow found itself, before the machine was asked. */
class PlaceProblem extends Error {
  readonly problem: { code: string };
  constructor(code: PlaceFailure["code"]) {
    super(code);
    this.problem = { code };
  }
}
