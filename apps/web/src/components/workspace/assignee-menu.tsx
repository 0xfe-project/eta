import type { Choice } from "./assignee-tree";
import type { AssigneeOption } from "@/queries/tasks";
import {
  CaretDownIcon,
  CaretLeftIcon,
  CaretRightIcon,
  CheckIcon,
} from "@phosphor-icons/react";
import { useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { assigneeTree } from "./assignee-tree";
import { assigneeFromKey, assigneeKey, remoteLabel } from "./task-format";

const compactQuery = "(max-width: 767px), (pointer: coarse)";
const subscribe = (notify: () => void) => {
  const media = window.matchMedia(compactQuery);
  media.addEventListener("change", notify);
  return () => media.removeEventListener("change", notify);
};
const snapshot = () => window.matchMedia(compactQuery).matches;
const serverSnapshot = () => false;
const menuClass =
  "w-56 max-w-[calc(100vw-1rem)] max-h-(--radix-dropdown-menu-content-available-height) overflow-y-auto p-1 duration-[60ms] ease-linear motion-reduce:animate-none";

export function AssigneeMenu({
  id,
  value,
  options,
  pending,
  error,
  retry,
  onChange,
}: {
  id: string;
  value: string;
  options: AssigneeOption[];
  pending: boolean;
  error?: string;
  retry: () => void;
  onChange: (value: string) => void;
}) {
  const compact = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  const [path, setPath] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const tree = assigneeTree(options);
  const selected = options.find(
    (o) => assigneeKey({ kind: "remote", ...o }) === value,
  );
  const assignee = assigneeFromKey(value);
  const label =
    value === "none"
      ? "未指派"
      : value === "user"
        ? "我"
        : selected
          ? remoteLabel(selected) + (selected.online ? "" : "（离线）")
          : `${remoteLabel({ ...assignee, computer_name: assignee.computer_id })}（不可用）`;
  const ancestors: Choice[] = [];
  let choices = tree;
  for (const key of path) {
    const parent = choices.find((c) => c.key === key);
    if (!parent?.children) break;
    ancestors.push(parent);
    choices = parent.children;
  }
  const navigate = (next: string[]) => {
    setPath(next);
    requestAnimationFrame(() =>
      contentRef.current
        ?.querySelector<HTMLElement>('[role="menuitem"]')
        ?.focus(),
    );
  };
  const isSelected = (choice: Choice): boolean =>
    choice.key === value || !!choice.children?.some(isSelected);
  const caption = (choice: Choice) => (
    <>
      <span className="min-w-0 break-words">
        {choice.label}
        {choice.offline ? "（离线）" : ""}
      </span>
      {isSelected(choice) ? (
        <CheckIcon aria-label="已选" className="ml-auto shrink-0" />
      ) : null}
    </>
  );
  const renderChoices = (items: Choice[]): React.ReactNode =>
    items.map((choice) =>
      choice.children ? (
        <DropdownMenuSub key={choice.key}>
          <DropdownMenuSubTrigger>{caption(choice)}</DropdownMenuSubTrigger>
          <DropdownMenuPortal>
            <DropdownMenuSubContent collisionPadding={8} className={menuClass}>
              {renderChoices(choice.children)}
            </DropdownMenuSubContent>
          </DropdownMenuPortal>
        </DropdownMenuSub>
      ) : (
        <DropdownMenuItem
          key={choice.key}
          onSelect={() => onChange(choice.key)}
        >
          {caption(choice)}
        </DropdownMenuItem>
      ),
    );
  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        setPath([]);
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          id={id}
          variant="outline"
          className="h-auto min-h-8 w-full justify-between text-left whitespace-normal"
        >
          <span className="min-w-0 break-words">{label}</span>
          <CaretDownIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        ref={contentRef}
        collisionPadding={8}
        className={menuClass}
        onKeyDown={(event) => {
          if (compact && event.key === "ArrowLeft" && path.length) {
            event.preventDefault();
            navigate(path.slice(0, -1));
          }
        }}
      >
        {compact && ancestors.length ? (
          <>
            <DropdownMenuItem
              className="min-h-11"
              onSelect={(event) => {
                event.preventDefault();
                navigate(path.slice(0, -1));
              }}
            >
              <CaretLeftIcon />
              返回
            </DropdownMenuItem>
            <DropdownMenuLabel className="break-words">
              {ancestors.map((c) => c.label).join(" · ")}
            </DropdownMenuLabel>
          </>
        ) : null}
        {compact
          ? choices.map((choice) => (
              <DropdownMenuItem
                key={choice.key}
                className="min-h-11"
                onSelect={(event) => {
                  if (choice.children) {
                    event.preventDefault();
                    navigate([...ancestors.map((c) => c.key), choice.key]);
                  } else onChange(choice.key);
                }}
              >
                {caption(choice)}
                {choice.children ? (
                  <CaretRightIcon className="ml-auto" />
                ) : null}
              </DropdownMenuItem>
            ))
          : renderChoices(tree)}
        {pending ? <DropdownMenuLabel>读取指派对象……</DropdownMenuLabel> : null}
        {error ? (
          <>
            <DropdownMenuLabel className="break-words text-destructive">
              {error}
            </DropdownMenuLabel>
            <DropdownMenuItem
              onSelect={(event) => {
                event.preventDefault();
                retry();
              }}
            >
              重试
            </DropdownMenuItem>
          </>
        ) : !pending && !options.length ? (
          <DropdownMenuLabel>暂无远程智能体</DropdownMenuLabel>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
