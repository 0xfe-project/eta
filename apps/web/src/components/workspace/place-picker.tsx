import type { KeyboardEvent, ReactNode } from "react";
import type { PlaceFlow } from "./use-place-flow";
import { WarningIcon } from "@phosphor-icons/react/Warning";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Empty, Loading } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { camelKey } from "./use-place-flow";

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

const KEYS = new Set(["ArrowDown", "ArrowUp", "Enter"]);

/**
 * Choosing a directory on a machine: one page of the flow at a time, a box and a list. Typing goes
 * in the box; up and down move the highlighted row; Enter takes it; Escape is the dialog's, which
 * asks the flow to go back a page first. What each page offers, and why a row is greyed out, is
 * the flow's (`usePlaceFlow`); this only draws it.
 */
export function PlacePicker({ flow }: { flow: PlaceFlow }) {
  const { t: translateText } = useTranslation(["chat", "common"] as const);
  const { page, rows, active, crumbs: listing, problem, clone } = flow;
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Every page starts with the keyboard in its box.
  const pageMachine = "machineId" in page ? page.machineId : "";
  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, [page.kind, pageMachine]);

  // The highlighted row stays in view as the arrows move it.
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || !KEYS.has(event.key)) return;
    if (flow.key(event.key as "ArrowDown" | "ArrowUp" | "Enter"))
      event.preventDefault();
  };

  const steps = stepsOf(flow, translateText);
  let section: string | undefined;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex min-w-0 items-center gap-1 border-b px-4 pt-2 text-xs text-muted-foreground">
        {steps.map((step, index) => (
          <span
            key={steps.slice(0, index + 1).join("\u0000")}
            className="flex min-w-0 items-center gap-1"
          >
            {index > 0 ? <span aria-hidden="true">›</span> : null}
            <span
              className={cn(
                "truncate",
                index === steps.length - 1 && "text-foreground",
              )}
            >
              {step}
            </span>
          </span>
        ))}
      </div>
      <div className="flex min-w-0 items-center gap-2 border-b px-4 py-1.5">
        {page.kind === "clone-location" ? (
          <span className="shrink-0 text-xs text-muted-foreground">
            {translateText("chat:new.places.cloneTo")}
          </span>
        ) : null}
        {page.kind === "new-name" ? (
          <span className="max-w-[45%] shrink-0 truncate font-mono text-xs text-muted-foreground">
            {page.parent.display}
            {flow.flavor === "win32" ? "\\" : "/"}
          </span>
        ) : null}
        <input
          ref={inputRef}
          aria-label={flow.placeholder}
          placeholder={flow.placeholder}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          value={page.query}
          disabled={page.busy}
          onChange={(event) => flow.type(event.target.value)}
          onKeyDown={onKey}
          className="h-8 min-w-0 flex-1 bg-transparent font-mono text-sm outline-none placeholder:font-sans placeholder:text-muted-foreground"
        />
        {page.kind === "browse" ? (
          <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
            <Checkbox
              checked={page.showHidden}
              onCheckedChange={(checked) => flow.showHidden(checked === true)}
            />
            {translateText("chat:new.picker.hidden")}
          </label>
        ) : null}
      </div>
      {listing !== undefined ? (
        <nav
          aria-label={translateText("chat:new.picker.crumbs")}
          className="flex min-w-0 flex-wrap items-center gap-x-0.5 border-b px-3 py-1 font-mono text-xs"
        >
          {listing.crumbs.map((crumb, index) => (
            <span key={crumb.path} className="flex items-center">
              {index > 0 ? (
                <span aria-hidden="true" className="text-muted-foreground">
                  {flow.flavor === "win32" ? "\\" : "/"}
                </span>
              ) : null}
              <button
                type="button"
                aria-current={
                  index === listing.crumbs.length - 1 ? "location" : undefined
                }
                className="px-1 py-0.5 text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:bg-muted aria-[current]:text-foreground"
                onClick={() => flow.walk(crumb.path)}
              >
                {crumb.name}
              </button>
            </span>
          ))}
          {listing.drives.length > 1 ? (
            <span className="ml-auto flex gap-0.5">
              {listing.drives.map((drive) => (
                <button
                  key={drive}
                  type="button"
                  className="px-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                  onClick={() => flow.walk(drive)}
                >
                  {drive.replace(/\\$/, "")}
                </button>
              ))}
            </span>
          ) : null}
        </nav>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {problem !== null ? (
          <p
            role="alert"
            className="flex items-start gap-1.5 border-b px-4 py-2 text-xs text-state-error"
          >
            <WarningIcon
              aria-hidden="true"
              className="mt-0.5 size-3.5 shrink-0"
            />
            <span className="min-w-0 flex-1">
              {translateText(
                `chat:new.places.problems.${camelKey(problem.code)}`,
              )}
              {problem.code === "other" && problem.detail !== undefined ? (
                <span className="block font-mono break-all text-muted-foreground">
                  {problem.detail}
                </span>
              ) : null}
            </span>
            {problem.code === "offline" || problem.code === "timeout" ? (
              <Button size="xs" variant="outline" onClick={flow.retry}>
                {translateText("common:actions.retry")}
              </Button>
            ) : null}
          </p>
        ) : null}
        {clone !== undefined ? (
          <div role="status" className="border-b px-4 py-2 text-xs">
            <div className="flex justify-between gap-2">
              <span className="truncate">
                {translateText("chat:new.places.cloning", {
                  path: clone.target.display,
                })}
              </span>
              <span className="shrink-0 text-muted-foreground">
                {clone.progress === null
                  ? ""
                  : `${clone.progress.phase} ${clone.progress.percent ?? ""}%`}
              </span>
            </div>
            <div className="mt-1 h-0.5 bg-muted">
              <div
                className="h-full bg-foreground transition-[width]"
                style={{ width: `${clone.progress?.percent ?? 0}%` }}
              />
            </div>
          </div>
        ) : null}
        {rows.length === 0 ? (
          flow.loading ? (
            <Loading rows={6} />
          ) : (
            <div className="grid h-full place-content-center px-4 text-center">
              <Empty title={translateText(emptyText(flow))} />
            </div>
          )
        ) : (
          <ul ref={listRef} role="listbox" aria-label={flow.placeholder}>
            {rows.map((row, index) => {
              const heading =
                row.section !== undefined && row.section !== section
                  ? row.section
                  : undefined;
              section = row.section;
              return (
                <li key={row.key} role="presentation">
                  {heading === undefined ? null : (
                    <div className="px-4 pt-2 pb-0.5 text-[11px] text-muted-foreground">
                      {heading}
                    </div>
                  )}
                  <button
                    type="button"
                    role="option"
                    tabIndex={-1}
                    data-index={index}
                    aria-selected={index === active}
                    aria-disabled={row.disabled}
                    disabled={row.disabled}
                    onMouseMove={() => {
                      if (index !== active && !row.disabled) flow.point(index);
                    }}
                    onClick={() => {
                      if (!row.disabled && !page.busy) row.take();
                    }}
                    className="flex min-h-8 w-full items-center gap-2 px-4 text-left text-sm outline-none aria-selected:bg-muted disabled:text-muted-foreground pointer-coarse:min-h-10"
                  >
                    <span className="min-w-0 truncate font-mono text-[13px]">
                      {row.label}
                    </span>
                    {row.tags.map((tag) => (
                      <Tag key={tag}>{tag}</Tag>
                    ))}
                    <span className="ml-auto min-w-0 shrink truncate text-xs text-muted-foreground">
                      {row.note ?? row.detail}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <div className="border-t px-4 py-1 text-[11px] text-muted-foreground">
        {translateText("chat:new.places.keys")}
      </div>
    </div>
  );
}

function emptyText(
  flow: PlaceFlow,
):
  | "chat:new.places.empty.github"
  | "chat:new.places.empty.newName"
  | "chat:new.places.empty.search"
  | "chat:new.picker.empty"
  | "chat:new.picker.noMatch" {
  const { page } = flow;
  if (page.kind === "github") return "chat:new.places.empty.github";
  if (page.kind === "new-name") return "chat:new.places.empty.newName";
  if (page.kind === "browse") return "chat:new.picker.empty";
  if (page.query.trim() !== "") return "chat:new.picker.noMatch";
  return "chat:new.places.empty.search";
}

/** Where the flow is, as a trail: the machine, then the way. */
function stepsOf(
  flow: PlaceFlow,
  translateText: (key: string, options?: Record<string, unknown>) => string,
): string[] {
  const { page, machine } = flow;
  if (page.kind === "machine")
    return [translateText("chat:new.places.steps.machine")];
  const steps = [machine?.name ?? ""];
  switch (page.kind) {
    case "search":
      steps.push(translateText("chat:new.places.methods.search"));
      break;
    case "browse":
      steps.push(translateText("chat:new.places.methods.browse"));
      break;
    case "github":
      steps.push(translateText("chat:new.places.methods.github"));
      break;
    case "clone-location":
      steps.push(
        translateText("chat:new.places.methods.github"),
        page.repo.nameWithOwner,
      );
      break;
    case "new-parent":
      steps.push(translateText("chat:new.places.methods.new"));
      break;
    case "new-name":
      steps.push(
        translateText("chat:new.places.methods.new"),
        page.parent.display,
      );
      break;
    default:
      break;
  }
  return steps;
}
