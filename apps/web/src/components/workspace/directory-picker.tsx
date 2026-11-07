import type { DirectoryEntry, ProjectView } from "@eta/client-contracts";
import type { KeyboardEvent, ReactNode } from "react";
import type { DirectoryBrowser } from "./use-directory-browser";
import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { FolderIcon } from "@phosphor-icons/react/Folder";
import { WarningIcon } from "@phosphor-icons/react/Warning";
import { useEffect, useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Empty, Loading } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { shortenPath } from "@/lib/projects";
import { cn } from "@/lib/utils";
import { useMachines } from "@/queries/projects";
import { StatusDot } from "./machine-settings";
import { moveRow } from "./use-directory-browser";
import { useChoosable, useUsableMachines } from "./use-project-choice";
import { useWorkspaceStore } from "./workspace-store";

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
  picks = false,
  children,
}: {
  name: string;
  onOpen: () => void;
  /** It chooses rather than goes in, so its arrow is not the one that walks. */
  picks?: boolean;
  children?: ReactNode;
}) {
  const Arrow = picks ? ArrowRightIcon : CaretRightIcon;
  return (
    <li>
      <button type="button" className={ROW} onClick={onOpen}>
        <FolderIcon
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground"
        />
        <span className="min-w-0 flex-1 truncate">{name}</span>
        {children}
        <Arrow
          aria-hidden="true"
          className="size-3 shrink-0 text-muted-foreground"
        />
      </button>
    </li>
  );
}

export const Tag = ({
  warn = false,
  children,
}: {
  warn?: boolean;
  children: ReactNode;
}) => (
  <Badge
    variant="secondary"
    className={cn(
      "h-4 px-1 text-[10px] font-normal text-muted-foreground",
      warn && "text-state-warning",
    )}
  >
    {children}
  </Badge>
);

const Heading = ({ children }: { children: ReactNode }) => (
  <li className="px-2 pt-2 pb-0.5 text-xs text-muted-foreground">{children}</li>
);

/**
 * Choosing a directory on a machine by walking to it.
 *
 * A click on a directory always goes in; what gets chosen is where you are, so there is no selected
 * row to keep apart from the current directory. A project is the exception: it is a choice already
 * made once, so a click takes it. A typed path is checked before the bar lets go of it, and a path
 * that does not work stays in the box to be fixed.
 */
export function DirectoryPicker({
  browser,
  onProject,
}: {
  browser: DirectoryBrowser;
  onProject: (project: ProjectView) => void;
}) {
  const { t: translateText } = useTranslation([
    "chat",
    "machines",
    "common",
  ] as const);
  const {
    machineId,
    listing,
    listed,
    home,
    current,
    problem,
    filter,
    setFilter,
    showHidden,
    setShowHidden,
    typing,
    setTyping,
    listRef,
    go,
    jump,
    closeTyping,
  } = browser;
  const { machines } = useMachines();
  const usable = useUsableMachines();
  const choosable = useChoosable();
  const recent = useWorkspaceStore(
    (state) => state.workspace.recentDirectories?.[machineId],
  );
  const crumbsRef = useRef<HTMLElement>(null);

  const onTypingKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") void jump();
  };

  // Whatever opened this step is gone: the keyboard starts here.
  useEffect(() => listRef.current?.focus({ preventScroll: true }), [listRef]);

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
  const used = (project: ProjectView) => {
    const at = recent?.indexOf(project.path) ?? -1;
    return at === -1 ? Number.MAX_SAFE_INTEGER : at;
  };
  const projects =
    listed !== undefined && listed.path === listed.home
      ? choosable
          .filter(
            (project) =>
              project.machineId === machineId &&
              project.name.toLowerCase().includes(needle),
          )
          .sort((a, b) => used(a) - used(b))
      : [];
  const up =
    current === undefined || current === "/" ? undefined : parentOf(current);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 px-4 py-3">
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
                aria-pressed={entry.id === machineId}
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
          onKeyDown={(event) => moveRow(event, listRef.current)}
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
        onKeyDown={(event) => moveRow(event, listRef.current)}
        className="min-h-0 flex-1 overflow-y-auto border border-border outline-none focus-visible:ring-1 focus-visible:ring-ring/50"
      >
        {listed !== undefined ? (
          entries.length === 0 && projects.length === 0 ? (
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
              {projects.length > 0 ? (
                <>
                  <Heading>{translateText("chat:new.project")}</Heading>
                  {projects.map((project) => (
                    <Row
                      key={project.id}
                      name={project.name}
                      picks
                      onOpen={() => onProject(project)}
                    >
                      <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
                        {shortenPath(parentOf(project.path), listed.home)}
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
    </div>
  );
}
