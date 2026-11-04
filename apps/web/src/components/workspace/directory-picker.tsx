import type { DirectoryEntry, DirectoryProblem } from "@eta/client-contracts";
import type { KeyboardEvent, ReactNode } from "react";
import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { FolderIcon } from "@phosphor-icons/react/Folder";
import { WarningIcon } from "@phosphor-icons/react/Warning";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Empty, Loading } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { folderName, shortenPath } from "@/lib/projects";
import { cn } from "@/lib/utils";
import { WireError } from "@/lib/wire";
import { directoriesQuery, useMachines } from "@/queries/projects";
import { StatusDot } from "./machine-settings";
import { useUsableMachines } from "./use-project-choice";
import { useWorkspaceStore } from "./workspace-store";

export interface DirectoryPickerProps {
  machineId: string;
  /** Where to open; undefined is the machine's home. */
  start: string | undefined;
  onPick: (path: string, machineId: string) => void;
  onBack: () => void;
}

/** What a caller is told when a listing failed; a failure without a code is nobody answering. */
function problemOf(error: unknown): DirectoryProblem {
  const code = error instanceof WireError ? error.problem?.code : undefined;
  return code === "not_found" || code === "denied" ? code : "offline";
}

const PROBLEM_TEXT = {
  not_found: "chat:new.picker.problems.notFound",
  denied: "chat:new.picker.problems.denied",
  offline: "chat:new.picker.problems.offline",
} as const;

/** The path as steps to click: from `~` inside the home, from `/` outside it. */
function crumbsOf(path: string, home: string | undefined) {
  const inside =
    home !== undefined &&
    home !== "/" &&
    (path === home || path.startsWith(`${home}/`));
  const root = inside ? home : "/";
  const crumbs = [{ name: inside ? "~" : "/", path: root }];
  let at = inside ? home : "";
  for (const name of path.slice(root.length).split("/")) {
    if (name === "") continue;
    at = `${at}/${name}`;
    crumbs.push({ name, path: at });
  }
  return crumbs;
}

const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";

const ROW =
  "flex min-h-8 w-full items-center gap-2 px-2 text-left text-sm outline-none hover:bg-muted focus-visible:bg-muted focus-visible:ring-1 focus-visible:ring-ring/50 focus-visible:ring-inset pointer-coarse:min-h-10";

function Row({
  name,
  onOpen,
  children,
}: {
  name: string;
  onOpen: () => void;
  children?: ReactNode;
}) {
  return (
    <li>
      <button type="button" className={ROW} onClick={onOpen}>
        <FolderIcon
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground"
        />
        <span className="min-w-0 flex-1 truncate">{name}</span>
        {children}
        <CaretRightIcon
          aria-hidden="true"
          className="size-3 shrink-0 text-muted-foreground"
        />
      </button>
    </li>
  );
}

const Tag = ({ children }: { children: ReactNode }) => (
  <Badge
    variant="secondary"
    className="h-4 px-1 text-[10px] font-normal text-muted-foreground"
  >
    {children}
  </Badge>
);

const Heading = ({ children }: { children: ReactNode }) => (
  <li className="px-2 pt-2 pb-0.5 text-xs text-muted-foreground">{children}</li>
);

/**
 * Choosing a directory on a machine by walking to it, in place of a dialog's form.
 *
 * A click always goes in; what gets chosen is where you are, so there is no selected row to keep
 * apart from the current directory. A typed path is checked before the bar lets go of it, and a
 * path that does not work stays in the box to be fixed.
 */
export function DirectoryPicker({
  machineId,
  start,
  onPick,
  onBack,
}: DirectoryPickerProps) {
  const { t: translateText } = useTranslation([
    "chat",
    "machines",
    "common",
  ] as const);
  const client = useQueryClient();
  const { machines } = useMachines();
  const usable = useUsableMachines();
  const [place, setPlace] = useState({ machineId, path: start });
  const [filter, setFilter] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [typing, setTyping] = useState<
    { value: string; problem?: DirectoryProblem } | undefined
  >(undefined);
  const listing = useQuery(directoriesQuery(place.machineId, place.path));
  const recent = useWorkspaceStore(
    (state) => state.workspace.recentDirectories?.[place.machineId],
  );
  const listRef = useRef<HTMLDivElement>(null);
  const crumbsRef = useRef<HTMLElement>(null);
  // The check of a typed path that is still the one that counts: one left behind says nothing.
  const attemptRef = useRef(0);

  const machine = machines.find((entry) => entry.id === place.machineId);
  const listed = listing.data;
  const home = listed?.home ?? machine?.home ?? undefined;
  const current = listed?.path ?? place.path ?? home;
  const problem = listing.isError ? problemOf(listing.error) : undefined;

  const go = (next: { machineId?: string; path: string | undefined }) => {
    attemptRef.current += 1;
    setPlace((now) => ({ ...now, ...next }));
    setFilter("");
    setTyping(undefined);
    // Whatever was pressed is gone with the list it was in; the keyboard carries on from the new
    // one. A box that holds focus rather than a row, because the rows are not there yet.
    listRef.current?.focus({ preventScroll: true });
  };

  const jump = async () => {
    const value = typing?.value.trim();
    if (value === undefined || value === "") return;
    attemptRef.current += 1;
    const mine = attemptRef.current;
    try {
      const found = await client.fetchQuery(
        directoriesQuery(place.machineId, value),
      );
      if (mine !== attemptRef.current) return;
      client.setQueryData(
        directoriesQuery(place.machineId, found.path).queryKey,
        found,
      );
      go({ path: found.path });
    } catch (error) {
      if (mine !== attemptRef.current) return;
      setTyping({ value, problem: problemOf(error) });
    }
  };

  const closeTyping = () => {
    attemptRef.current += 1;
    setTyping(undefined);
  };

  const onTypingKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") void jump();
    if (event.key === "Escape") {
      // One step back: the dialog's Escape would leave the view.
      event.stopPropagation();
      closeTyping();
    }
  };

  /** Up and down walk the rows; a filter box hands over to the first one. */
  const moveRow = (event: KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const rows = [
      ...(listRef.current?.querySelectorAll<HTMLElement>("button") ?? []),
    ];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    const next = rows[event.key === "ArrowDown" ? at + 1 : Math.max(at - 1, 0)];
    if (next === undefined) return;
    event.preventDefault();
    next.focus();
  };

  // The option that opened this view went with the form: the keyboard starts here.
  useEffect(() => listRef.current?.focus({ preventScroll: true }), []);

  const showingCrumbs = typing === undefined;
  // The end of the path is the part that matters, and the part a narrow bar would scroll away.
  useLayoutEffect(() => {
    const crumbs = crumbsRef.current;
    if (crumbs !== null) crumbs.scrollLeft = crumbs.scrollWidth;
  }, [current, showingCrumbs]);

  const needle = filter.trim().toLowerCase();
  const entries = (listed?.entries ?? []).filter(
    (entry: DirectoryEntry) =>
      (showHidden || !entry.hidden) &&
      entry.name.toLowerCase().includes(needle),
  );
  const recents =
    listed !== undefined && listed.path === listed.home && needle === ""
      ? (recent ?? []).filter((path) => path !== listed.path)
      : [];
  const up =
    current === undefined || current === "/" ? undefined : parentOf(current);

  return (
    <div className="grid min-w-0 gap-3">
      <DialogHeader className="flex-row items-start gap-2 pr-6">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={translateText("common:actions.back")}
          onClick={onBack}
        >
          <ArrowLeftIcon />
        </Button>
        <div className="grid min-w-0 gap-1">
          <DialogTitle>{translateText("chat:new.picker.title")}</DialogTitle>
          <DialogDescription>
            {translateText("chat:new.picker.hint")}
          </DialogDescription>
        </div>
      </DialogHeader>
      <div className="grid min-w-0 grid-cols-1 gap-2">
        {usable.length > 1 ? (
          <div
            role="group"
            aria-label={translateText("chat:new.picker.machine")}
            className="flex flex-wrap gap-1"
          >
            {machines
              .filter(
                (entry) =>
                  entry.status === "online" || entry.status === "offline",
              )
              .map((entry) => (
                <Button
                  key={entry.id}
                  variant="ghost"
                  size="xs"
                  disabled={entry.status !== "online"}
                  aria-pressed={entry.id === place.machineId}
                  className="aria-pressed:bg-muted pointer-coarse:h-10"
                  onClick={() => go({ machineId: entry.id, path: undefined })}
                >
                  <StatusDot
                    status={entry.status}
                    label={translateText(`machines:status.${entry.status}`)}
                  />
                  {entry.name}
                </Button>
              ))}
          </div>
        ) : null}
        <div>
          <div
            className={cn(
              "flex min-h-8 min-w-0 items-center gap-1 border border-input pr-1 pl-2",
              typing?.problem !== undefined && "border-destructive",
            )}
          >
            {typing === undefined ? (
              <nav
                ref={crumbsRef}
                aria-label={translateText("chat:new.picker.crumbs")}
                className="flex min-w-0 flex-1 items-center overflow-x-auto font-mono text-xs whitespace-nowrap [scrollbar-width:none]"
              >
                {crumbsOf(current ?? "/", home).map((crumb, index, crumbs) => {
                  const last = index === crumbs.length - 1;
                  return (
                    <span key={crumb.path} className="flex items-center">
                      {index > 0 && crumbs[index - 1]!.name !== "/" ? (
                        <span
                          aria-hidden="true"
                          className="text-muted-foreground"
                        >
                          /
                        </span>
                      ) : null}
                      <button
                        type="button"
                        aria-current={last ? "location" : undefined}
                        className="px-1 py-0.5 text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:text-foreground aria-[current]:font-medium aria-[current]:text-foreground pointer-coarse:py-2"
                        onClick={() => go({ path: crumb.path })}
                      >
                        {crumb.name}
                      </button>
                    </span>
                  );
                })}
              </nav>
            ) : (
              <input
                autoFocus
                onFocus={({ target }) =>
                  target.setSelectionRange(
                    target.value.length,
                    target.value.length,
                  )
                }
                aria-label={translateText("chat:new.path")}
                aria-invalid={typing.problem !== undefined}
                aria-describedby={
                  typing.problem === undefined ? undefined : "directory-problem"
                }
                placeholder={translateText("chat:groups.fields.cwdPlaceholder")}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                value={typing.value}
                onChange={(event) => setTyping({ value: event.target.value })}
                onKeyDown={onTypingKey}
                className="h-7 min-w-0 flex-1 bg-transparent font-mono text-xs outline-none placeholder:text-muted-foreground"
              />
            )}
            <Button
              variant="ghost"
              size="xs"
              className="pointer-coarse:h-8"
              onClick={() =>
                typing === undefined
                  ? setTyping({ value: current ?? "" })
                  : closeTyping()
              }
            >
              {translateText(
                typing === undefined
                  ? "chat:new.picker.typePath"
                  : "common:actions.cancel",
              )}
            </Button>
          </div>
          {typing?.problem === undefined ? null : (
            <p
              id="directory-problem"
              role="alert"
              className="mt-1 text-xs text-state-error"
            >
              {translateText(PROBLEM_TEXT[typing.problem])}
            </p>
          )}
        </div>
        <div className="flex min-w-0 items-center gap-3">
          <Input
            aria-label={translateText("chat:new.picker.filter")}
            placeholder={translateText("chat:new.picker.filter")}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            onKeyDown={moveRow}
            className="h-7 flex-1 pointer-coarse:h-9"
          />
          <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
            <Checkbox
              checked={showHidden}
              onCheckedChange={(checked) => setShowHidden(checked === true)}
            />
            {translateText("chat:new.picker.hidden")}
          </label>
        </div>
        <div
          ref={listRef}
          tabIndex={-1}
          onKeyDown={moveRow}
          className="h-[min(440px,calc(100dvh-16rem))] min-h-40 overflow-y-auto border border-border outline-none focus-visible:ring-1 focus-visible:ring-ring/50 sm:h-72"
        >
          {listed !== undefined ? (
            entries.length === 0 && recents.length === 0 ? (
              <div className="grid h-full place-content-center">
                <Empty
                  title={translateText(
                    needle === ""
                      ? "chat:new.picker.empty"
                      : "chat:new.picker.noMatch",
                  )}
                />
              </div>
            ) : (
              <ul>
                {recents.length > 0 ? (
                  <>
                    <Heading>{translateText("chat:new.picker.recent")}</Heading>
                    {recents.map((path) => (
                      <Row
                        key={path}
                        name={folderName(path)}
                        onOpen={() => go({ path })}
                      >
                        <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
                          {shortenPath(parentOf(path), listed.home)}
                        </span>
                      </Row>
                    ))}
                    <Heading>{translateText("chat:new.picker.home")}</Heading>
                  </>
                ) : null}
                {entries.map((entry) => (
                  <Row
                    key={entry.name}
                    name={entry.name}
                    onOpen={() =>
                      go({
                        path: `${listed.path === "/" ? "" : listed.path}/${entry.name}`,
                      })
                    }
                  >
                    {entry.git ? <Tag>git</Tag> : null}
                    {entry.projectId === null ? null : (
                      <Tag>{translateText("chat:new.picker.added")}</Tag>
                    )}
                  </Row>
                ))}
                {listed.truncated ? (
                  <li className="px-2 py-2 text-xs text-muted-foreground">
                    {translateText("chat:new.picker.truncated", {
                      limit: listed.entries.length,
                    })}
                  </li>
                ) : null}
              </ul>
            )
          ) : problem !== undefined ? (
            <div role="alert" className="grid h-full place-content-center">
              <Empty
                icon={WarningIcon}
                title={translateText(PROBLEM_TEXT[problem])}
                action={
                  problem === "offline" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void listing.refetch()}
                    >
                      {translateText("common:actions.retry")}
                    </Button>
                  ) : up === undefined ? null : (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => go({ path: up })}
                    >
                      {translateText("chat:new.picker.up")}
                    </Button>
                  )
                }
              />
            </div>
          ) : (
            <Loading rows={8} />
          )}
        </div>
        <div className="flex min-w-0 items-center gap-2">
          {/* Right to left so a long path gives up its start; `bdi` keeps its own order intact. */}
          <span
            title={current}
            className="min-w-0 flex-1 truncate text-left font-mono text-xs text-muted-foreground [direction:rtl]"
          >
            <bdi>
              {current === undefined ? "" : shortenPath(current, home ?? null)}
            </bdi>
          </span>
          <Button variant="ghost" onClick={onBack}>
            {translateText("common:actions.cancel")}
          </Button>
          <Button
            disabled={listed === undefined || typing !== undefined}
            onClick={() => {
              if (listed !== undefined) onPick(listed.path, place.machineId);
            }}
          >
            {translateText("chat:new.picker.choose")}
          </Button>
        </div>
      </div>
    </div>
  );
}
