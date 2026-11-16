import type { ArtifactView } from "@eta/client-contracts";
import type {
  ArtifactFilters,
  ArtifactSort,
  DayGroup,
} from "./artifact-filter";
import { AppWindowIcon } from "@phosphor-icons/react/AppWindow";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { CaretLeftIcon } from "@phosphor-icons/react/CaretLeft";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { FunnelSimpleIcon } from "@phosphor-icons/react/FunnelSimple";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/MagnifyingGlass";
import { XIcon } from "@phosphor-icons/react/X";
import { Link } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Empty, Loading } from "@/components/states";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatLocale } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { agentName, useAgentList } from "@/queries/agents";
import { useAllTasks } from "@/queries/tasks";
import { ArtifactButton } from "./artifact-dialog";
import {
  applyFilters,
  isFiltered,
  matchRanges,
  NO_PUBLISHER,
  pageRows,
  pageWindow,
  publisherCounts,
  timeOf,
  useArtifactFilters,
  useGroupArtifacts,
  withTaskCount,
} from "./artifact-filter";
import { when } from "./routine-format";
import { useGroups } from "./use-groups";
import { useSectionLink } from "./workspace-search";

// ---- The row ------------------------------------------------------------------------------------

function Highlighted({ text, query }: { text: string; query: string }) {
  const ranges = matchRanges(text, query);
  if (!ranges.length) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) parts.push(text.slice(at, start));
    parts.push(
      <mark key={start} className="bg-highlight px-px text-inherit">
        {text.slice(start, end)}
      </mark>,
    );
    at = end;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}

const clock = (at: number) =>
  new Date(at).toLocaleTimeString(formatLocale(), {
    hour: "2-digit",
    minute: "2-digit",
  });

/**
 * When, as short as the row's place lets it be: under a 今天 or 昨天 heading the clock is enough,
 * under 更早 the date; with no heading above, both.
 */
function rowTime(at: number, group: DayGroup | null) {
  if (group === "today" || group === "yesterday") return clock(at);
  if (group === "earlier") {
    const date = new Date(at);
    return `${date.getMonth() + 1}-${String(date.getDate()).padStart(2, "0")}`;
  }
  return when(at);
}

/**
 * One artifact as a row of a list: the title, then who published it, which version and when. The
 * whole row opens the newest version, as the cards elsewhere do; the task tag on it is a link of
 * its own to the task it was made for. The Artifacts tab and the context tab draw the same row.
 */
export function ArtifactRow({
  artifact,
  query = "",
  group = null,
  at = artifact.updatedAt,
}: {
  artifact: ArtifactView;
  /** What the search matched in the title, marked. */
  query?: string;
  /** The day heading it sits under, which decides how much of the time to say. */
  group?: DayGroup | null;
  /** The time it is listed by. */
  at?: number;
}) {
  const { t: translateText } = useTranslation(["artifacts", "common"] as const);
  const { agents } = useAgentList();
  const { tasks } = useAllTasks();
  const sectionLink = useSectionLink();
  const version = artifact.versions[0]?.number;
  const task =
    artifact.taskId === null
      ? undefined
      : tasks.find((t) => t.id === artifact.taskId);
  const label = [
    translateText("artifacts:actions.open"),
    artifact.title,
    version ? translateText("artifacts:version.label", { version }) : null,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    // The button's `after` is stretched over the whole row, so a click anywhere on it opens the
    // artifact; the task tag sits above that layer and keeps its own click.
    <div className="relative grid grid-cols-[1rem_minmax(0,1fr)] gap-x-2 px-3 py-1.5 hover:bg-muted">
      <AppWindowIcon
        aria-hidden="true"
        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
      />
      <ArtifactButton
        id={artifact.id}
        version={version}
        aria-label={label}
        title={artifact.title}
        className="truncate text-left text-xs/5 text-foreground outline-none after:absolute after:inset-0 focus-visible:after:ring-1 focus-visible:after:ring-ring focus-visible:after:ring-inset"
      >
        <Highlighted text={artifact.title} query={query} />
      </ArtifactButton>
      <div className="col-start-2 flex min-w-0 flex-wrap items-center gap-x-1.5 text-[11px]/4 text-muted-foreground tabular-nums">
        <span className="truncate">
          {agentName(agents, artifact.publisherAgentId)}
        </span>
        {version ? (
          <span>· {translateText("artifacts:list.version", { version })}</span>
        ) : null}
        <span>· {rowTime(at, group)}</span>
        {task ? (
          <Link
            {...sectionLink("tasks", { task: task.id })}
            aria-label={translateText("artifacts:list.openTask", {
              number: task.number,
            })}
            title={task.title}
            className="relative z-10 border border-border px-1 text-foreground hover:bg-background focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
          >
            #{task.number}
          </Link>
        ) : null}
      </div>
    </div>
  );
}

// ---- The tab ------------------------------------------------------------------------------------

/** Under this the publisher chips move into the menu. */
const NARROW_REM = 30;

function useNarrow(ref: React.RefObject<HTMLElement | null>) {
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const rem =
        Number.parseFloat(
          getComputedStyle(document.documentElement).fontSize,
        ) || 16;
      const width = element.getBoundingClientRect().width;
      // A width of 0 is a tree that is not laid out (a hidden drawer): keep what it was.
      if (width > 0) setNarrow(width < NARROW_REM * rem);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return narrow;
}

const sorts: ArtifactSort[] = ["updated", "created", "title"];
const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

/** A group chat's Artifacts tab: what its agents published in it, to search, filter and page through. */
export function GroupArtifacts() {
  const { current: group } = useGroups();
  const { artifacts, loaded } = useGroupArtifacts(group?.id);
  const { t: translateText } = useTranslation(["artifacts"] as const);
  if (!group) return null;
  if (!loaded)
    return (
      <div className="p-3">
        <Loading rows={2} />
      </div>
    );
  if (!artifacts.length)
    return (
      <div className="p-3">
        <Empty
          icon={AppWindowIcon}
          title={translateText("artifacts:empty.title")}
        >
          {translateText("artifacts:empty.description")}
        </Empty>
      </div>
    );
  return <ArtifactBrowser groupId={group.id} artifacts={artifacts} />;
}

function ArtifactBrowser({
  groupId,
  artifacts,
}: {
  groupId: string;
  artifacts: readonly ArtifactView[];
}) {
  const { t: translateText } = useTranslation(["artifacts", "common"] as const);
  const { agents } = useAgentList();
  const [filters, update] = useArtifactFilters(groupId);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const narrow = useNarrow(rootRef);

  // `/` anywhere in the panel, outside a field, goes to the search.
  useEffect(() => {
    const panel =
      rootRef.current?.closest("#workspace-panel") ?? rootRef.current;
    if (!panel) return;
    const onKey = (event: Event) => {
      const e = event as KeyboardEvent;
      if (
        e.key !== "/" ||
        e.metaKey ||
        e.ctrlKey ||
        e.altKey ||
        isTyping(e.target)
      )
        return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    panel.addEventListener("keydown", onKey);
    return () => panel.removeEventListener("keydown", onKey);
  }, []);

  const counts = publisherCounts(artifacts, filters);
  const shown = applyFilters(artifacts, filters);
  const { page, pages, first, last, sections } = pageRows(shown, filters);
  const filtered = isFiltered(filters);
  const many = counts.publishers.length > 1;
  const publisherLabel = (id: string) =>
    agentName(agents, id === NO_PUBLISHER ? null : id);
  const clear = () =>
    update({ query: "", publisher: null, withTask: false, revised: false });
  const goTo = (to: number) => {
    update({ page: to });
    if (listRef.current) listRef.current.scrollTop = 0;
  };

  const menu = (
    <SortMenu
      filters={filters}
      update={update}
      narrow={narrow}
      publishers={many ? counts : undefined}
      publisherLabel={publisherLabel}
      withTask={withTaskCount(artifacts)}
    />
  );

  return (
    <div ref={rootRef} className="flex min-h-0 flex-1 flex-col">
      <div className="grid flex-none gap-2 border-b border-border px-3 pt-2.5 pb-2">
        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <MagnifyingGlassIcon
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <input
              ref={searchRef}
              type="search"
              value={filters.query}
              aria-label={translateText("artifacts:list.searchLabel")}
              placeholder={translateText("artifacts:list.searchPlaceholder")}
              onChange={(e) => update({ query: e.target.value })}
              onKeyDown={(e) => {
                if (e.key !== "Escape") return;
                // Esc empties the box; on an empty box it hands the key on (a drawer closes).
                if (filters.query !== "") {
                  e.preventDefault();
                  e.stopPropagation();
                  update({ query: "" });
                } else e.currentTarget.blur();
              }}
              className="peer h-7 w-full min-w-0 border border-input bg-background pr-7 pl-7 text-xs outline-none placeholder:text-faint focus-visible:border-foreground [&::-webkit-search-cancel-button]:hidden"
            />
            {filters.query ? (
              <button
                type="button"
                aria-label={translateText("artifacts:list.clearSearch")}
                onClick={() => {
                  update({ query: "" });
                  searchRef.current?.focus();
                }}
                className="absolute top-1/2 right-1.5 grid size-5 -translate-y-1/2 place-items-center text-muted-foreground hover:text-foreground"
              >
                <XIcon aria-hidden="true" className="size-3" />
              </button>
            ) : (
              <kbd
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 border border-border px-1 font-sans text-[10px] text-faint peer-focus:hidden"
              >
                /
              </kbd>
            )}
          </div>
          {narrow ? menu : null}
        </div>
        {narrow ? null : (
          <div className="flex flex-wrap items-center gap-1.5">
            {many ? (
              <div
                role="group"
                aria-label={translateText("artifacts:list.publishers")}
                className="contents"
              >
                <Chip
                  on={filters.publisher === null}
                  label={translateText("artifacts:list.all")}
                  count={counts.all}
                  onClick={() => update({ publisher: null })}
                />
                {counts.publishers.map(({ id, count }) => (
                  <Chip
                    key={id}
                    on={filters.publisher === id}
                    label={publisherLabel(id)}
                    count={count}
                    onClick={() => update({ publisher: id })}
                  />
                ))}
              </div>
            ) : null}
            <div className="ml-auto">{menu}</div>
          </div>
        )}
        {filtered ? (
          <div className="flex items-center justify-between text-[11px] text-faint tabular-nums">
            <span data-found="">
              {translateText("artifacts:list.found", {
                total: artifacts.length,
                count: shown.length,
              })}
            </span>
            <button
              type="button"
              onClick={clear}
              className="text-muted-foreground hover:text-foreground"
            >
              {translateText("artifacts:list.clear")}
            </button>
          </div>
        ) : null}
      </div>

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto">
        {shown.length === 0 ? (
          <div className="grid justify-items-center gap-3 px-5 py-10 text-center text-xs text-muted-foreground">
            <p>
              {filters.query.trim()
                ? translateText("artifacts:list.noMatch", {
                    query: filters.query.trim(),
                  })
                : translateText("artifacts:list.noFilterMatch")}
            </p>
            <Button size="xs" variant="outline" onClick={clear}>
              {translateText("artifacts:list.clear")}
            </Button>
          </div>
        ) : (
          sections.map(({ group, items }) => (
            <section
              key={items[0]!.id}
              aria-label={
                group === null
                  ? undefined
                  : translateText(`artifacts:list.groups.${group}`)
              }
            >
              {group === null ? null : (
                <h3 className="sticky top-0 z-20 bg-surface px-3 pt-2.5 pb-1 text-[11px] text-faint">
                  {translateText(`artifacts:list.groups.${group}`)}
                </h3>
              )}
              <ul
                aria-label="Artifacts"
                className="divide-y divide-border border-b border-border"
              >
                {items.map((a) => (
                  <li key={a.id}>
                    <ArtifactRow
                      artifact={a}
                      query={filters.query}
                      group={group}
                      at={timeOf(a, filters.sort)}
                    />
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>

      {/* Nothing found has nothing to count: the empty state says so. */}
      {shown.length === 0 ? null : (
        <nav
          aria-label={translateText("artifacts:list.pagination")}
          className="flex flex-none items-center gap-1 border-t border-border bg-surface px-3 py-1.5 text-xs text-muted-foreground tabular-nums"
        >
          <span data-range="">
            {translateText("artifacts:list.range", {
              first,
              last,
              total: shown.length,
            })}
          </span>
          <span className="flex-1" />
          {pages > 1 ? (
            <>
              <PageButton
                label={translateText("artifacts:list.previous")}
                disabled={page === 1}
                onClick={() => goTo(page - 1)}
              >
                <CaretLeftIcon aria-hidden="true" className="size-3" />
              </PageButton>
              {pageWindow(page, pages).map((p) =>
                typeof p === "string" ? (
                  <span key={p} className="px-1 text-faint">
                    …
                  </span>
                ) : (
                  <PageButton
                    key={p}
                    label={translateText("artifacts:list.page", { page: p })}
                    current={p === page}
                    onClick={() => goTo(p)}
                  >
                    {p}
                  </PageButton>
                ),
              )}
              <PageButton
                label={translateText("artifacts:list.next")}
                disabled={page === pages}
                onClick={() => goTo(page + 1)}
              >
                <CaretRightIcon aria-hidden="true" className="size-3" />
              </PageButton>
            </>
          ) : null}
        </nav>
      )}
    </div>
  );
}

function Chip({
  on,
  label,
  count,
  onClick,
}: {
  on: boolean;
  label: string;
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        "h-6 max-w-40 truncate border px-2 text-xs whitespace-nowrap outline-none focus-visible:ring-1 focus-visible:ring-ring",
        on
          ? "border-foreground bg-foreground text-background"
          : "border-border bg-background text-foreground hover:bg-muted",
      )}
    >
      {label}
      <span
        className={cn(
          "ml-1 tabular-nums",
          on ? "text-background/70" : "text-faint",
        )}
      >
        {count}
      </span>
    </button>
  );
}

function PageButton({
  label,
  current = false,
  disabled = false,
  onClick,
  children,
}: {
  label: string;
  current?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-current={current ? "page" : undefined}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "grid h-6 min-w-6 place-items-center border px-1 text-foreground outline-none hover:bg-muted focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:text-faint",
        current ? "border-foreground" : "border-transparent",
      )}
    >
      {children}
    </button>
  );
}

function SortMenu({
  filters,
  update,
  narrow,
  publishers,
  publisherLabel,
  withTask,
}: {
  filters: ArtifactFilters;
  update: (patch: Partial<ArtifactFilters>) => void;
  narrow: boolean;
  publishers: ReturnType<typeof publisherCounts> | undefined;
  publisherLabel: (id: string) => string;
  withTask: number;
}) {
  const { t: translateText } = useTranslation(["artifacts"] as const);
  const sortLabel = translateText(`artifacts:list.sortBy.${filters.sort}`);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {narrow ? (
          <Button
            size="xs"
            variant="outline"
            className={cn(
              "h-7 shrink-0",
              (filters.publisher !== null ||
                filters.withTask ||
                filters.revised) &&
                "border-foreground",
            )}
          >
            <FunnelSimpleIcon aria-hidden="true" />
            {translateText("artifacts:list.filter")}
          </Button>
        ) : (
          <button
            type="button"
            className="flex h-6 items-center gap-1 text-xs whitespace-nowrap text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
          >
            {translateText("artifacts:list.sort")}
            <span className="text-foreground">{sortLabel}</span>
            <CaretDownIcon aria-hidden="true" className="size-3" />
          </button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel className="text-[11px] text-faint">
          {translateText("artifacts:list.sort")}
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={filters.sort}
          onValueChange={(sort) => update({ sort: sort as ArtifactSort })}
        >
          {sorts.map((sort) => (
            <DropdownMenuRadioItem key={sort} value={sort}>
              {translateText(`artifacts:list.sortBy.${sort}`)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-[11px] text-faint">
          {translateText("artifacts:list.only")}
        </DropdownMenuLabel>
        {/* Two that can both be on: the menu stays open between them. */}
        <DropdownMenuCheckboxItem
          checked={filters.withTask}
          onSelect={(e) => e.preventDefault()}
          onCheckedChange={(on) => update({ withTask: on === true })}
        >
          <span className="flex-1">
            {translateText("artifacts:list.withTask")}
          </span>
          <span className="text-faint tabular-nums">{withTask}</span>
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={filters.revised}
          onSelect={(e) => e.preventDefault()}
          onCheckedChange={(on) => update({ revised: on === true })}
        >
          {translateText("artifacts:list.revised")}
        </DropdownMenuCheckboxItem>
        {narrow && publishers ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[11px] text-faint">
              {translateText("artifacts:list.publishers")}
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={filters.publisher ?? "*"}
              onValueChange={(id) =>
                update({ publisher: id === "*" ? null : id })
              }
            >
              <DropdownMenuRadioItem value="*">
                <span className="flex-1">
                  {translateText("artifacts:list.all")}
                </span>
                <span className="text-faint tabular-nums">
                  {publishers.all}
                </span>
              </DropdownMenuRadioItem>
              {publishers.publishers.map(({ id, count }) => (
                <DropdownMenuRadioItem key={id} value={id}>
                  <span className="flex-1 truncate">{publisherLabel(id)}</span>
                  <span className="text-faint tabular-nums">{count}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
