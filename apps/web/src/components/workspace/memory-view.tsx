import type { Memory } from "@/queries/memory";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/ArrowClockwise";
import { BrainIcon } from "@phosphor-icons/react/Brain";
import { CaretLeftIcon } from "@phosphor-icons/react/CaretLeft";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { ChatCircleDotsIcon } from "@phosphor-icons/react/ChatCircleDots";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/MagnifyingGlass";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { RobotIcon } from "@phosphor-icons/react/Robot";
import { TrashIcon } from "@phosphor-icons/react/Trash";
import { UserIcon } from "@phosphor-icons/react/User";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Empty, LoadError, Loading } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectOption } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useForget, useMemories, useRemember } from "@/queries/memory";
import { ago } from "./task-format";
import { useAgents } from "./use-agents";

// Each search embeds the query; wait for the user to stop typing.
const SEARCH_DELAY_MS = 300;
const PAGE_SIZE = 20;

const sources = {
  conversation: { icon: ChatCircleDotsIcon, label: "对话中记下" },
  agent: { icon: RobotIcon, label: "智能体记下" },
  user: { icon: UserIcon, label: "手动添加" },
};

function useDebounced(value: string) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(setDebounced, SEARCH_DELAY_MS, value);
    return () => clearTimeout(timer);
  }, [value]);
  return debounced;
}

function date(iso: string) {
  return new Date(iso).toLocaleString("zh-CN", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function RememberForm({ agentId }: { agentId: string }) {
  const [text, setText] = useState("");
  const remember = useRemember(agentId);
  const submit = () => {
    const value = text.trim();
    if (!value || remember.isPending) return;
    remember.mutate(value, {
      onSuccess: () => setText(""),
      onError: (error) => toast.error(error.message),
    });
  };
  return (
    <form
      className="flex items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Textarea
        aria-label="新的记忆"
        placeholder="让智能体记住一件事，例如：我习惯用 pnpm"
        value={text}
        maxLength={8000}
        rows={1}
        className="min-h-8 resize-none"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <Button type="submit" disabled={!text.trim() || remember.isPending}>
        记住
      </Button>
    </form>
  );
}

function MemoryRow({ agentId, memory }: { agentId: string; memory: Memory }) {
  const forget = useForget(agentId);
  const textRef = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  // Whether the clamped text hides some of it; measured while clamped, so
  // the toggle stays once expanded.
  const [long, setLong] = useState(false);
  useLayoutEffect(() => {
    const element = textRef.current;
    if (!element || expanded) return;
    const measure = () =>
      setLong(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [expanded, memory.text]);
  const source = memory.source ? sources[memory.source] : undefined;

  return (
    <li className="group px-3 py-2.5">
      <p
        ref={textRef}
        className={cn(
          "text-sm leading-relaxed break-words whitespace-pre-wrap",
          expanded ? null : "line-clamp-3",
        )}
      >
        {memory.text}
      </p>
      <div className="mt-1 flex h-6 items-center gap-3 text-xs text-muted-foreground">
        {source ? (
          <span className="flex items-center gap-1">
            <source.icon aria-hidden="true" className="size-3.5" />
            {source.label}
          </span>
        ) : null}
        {memory.created_at ? (
          <time
            dateTime={memory.created_at}
            title={date(memory.created_at)}
            className="tabular-nums"
          >
            {ago(memory.created_at)}
          </time>
        ) : null}
        {long ? (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
            className="text-foreground/70 outline-none hover:text-foreground focus-visible:underline"
          >
            {expanded ? "收起" : "展开"}
          </button>
        ) : null}
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="忘记这条记忆"
          title="忘记"
          disabled={forget.isPending}
          className="ml-auto opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
          onClick={() =>
            forget.mutate(memory.id, {
              onError: (error) => toast.error(error.message),
            })
          }
        >
          <TrashIcon aria-hidden="true" />
        </Button>
      </div>
    </li>
  );
}

/** One page of memories at a time, with the pages under them. */
function MemoryList({
  agentId,
  memories,
}: {
  agentId: string;
  memories: Memory[];
}) {
  const listRef = useRef<HTMLUListElement>(null);
  const [page, setPage] = useState(0);
  const pages = Math.ceil(memories.length / PAGE_SIZE);
  // Forgetting the last memory of the last page leaves the page empty.
  const current = Math.min(page, pages - 1);
  const go = (to: number) => {
    setPage(to);
    listRef.current?.scrollIntoView({ block: "nearest" });
  };
  return (
    <div className="space-y-2">
      <ul ref={listRef} aria-label="记忆列表" className="divide-y border">
        {memories
          .slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE)
          .map((memory) => (
            <MemoryRow key={memory.id} agentId={agentId} memory={memory} />
          ))}
      </ul>
      {pages > 1 ? (
        <nav
          aria-label="记忆分页"
          className="flex items-center justify-end gap-1 text-xs text-muted-foreground tabular-nums"
        >
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="上一页"
            disabled={current === 0}
            onClick={() => go(current - 1)}
          >
            <CaretLeftIcon aria-hidden="true" />
          </Button>
          <span aria-current="page" className="min-w-10 text-center">
            {current + 1} / {pages}
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="下一页"
            disabled={current === pages - 1}
            onClick={() => go(current + 1)}
          >
            <CaretRightIcon aria-hidden="true" />
          </Button>
        </nav>
      ) : null}
    </div>
  );
}

/**
 * An agent's long-term memories: browse, search, add and forget. Shows the
 * given agent (else the newest); `onAgentChange` adds a switcher.
 */
export function MemoryView({
  agentId,
  onAgentChange,
}: {
  agentId: string | undefined;
  onAgentChange?: (agentId: string) => void;
}) {
  const { agents, loaded, error: agentsError, retry, openEditor } = useAgents();
  const current = agents.find((agent) => agent.id === agentId) ?? agents.at(-1);
  const [search, setSearch] = useState("");
  const query = useDebounced(search.trim());
  const { data, error, isPending, isFetching, refetch } = useMemories(
    current?.id,
    query,
  );

  if (agentsError && !loaded)
    return <LoadError what="智能体" error={agentsError} onRetry={retry} />;
  if (!loaded) return <Loading />;
  if (!current)
    return (
      <Empty
        icon={RobotIcon}
        title="还没有智能体"
        action={
          <Button size="sm" onClick={() => openEditor()}>
            <PlusIcon aria-hidden="true" data-icon="inline-start" />
            新建智能体
          </Button>
        }
      >
        记忆属于某个智能体，在和它的对话里慢慢积累。
      </Empty>
    );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
          {onAgentChange ? (
            <Select
              size="sm"
              aria-label="智能体"
              value={current.id}
              onValueChange={(value) => onAgentChange(value)}
            >
              {agents.map((agent) => (
                <SelectOption key={agent.id} value={agent.id}>
                  {agent.name}
                </SelectOption>
              ))}
            </Select>
          ) : (
            <span className="truncate">{current.name}</span>
          )}
          <span className="shrink-0">的记忆</span>
          {data ? (
            <span className="font-normal tabular-nums text-muted-foreground">
              {data.length}
            </span>
          ) : null}
        </h2>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="刷新记忆列表"
            title="刷新"
            disabled={isFetching}
            onClick={() => void refetch()}
          >
            <ArrowClockwiseIcon
              aria-hidden="true"
              className={isFetching ? "animate-spin" : undefined}
            />
          </Button>
          <div className="relative w-48">
            <MagnifyingGlassIcon
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              type="search"
              aria-label="搜索记忆"
              placeholder="搜索"
              value={search}
              className="pl-7"
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
      </div>
      <RememberForm agentId={current.id} />
      {error ? (
        <LoadError what="记忆" error={error} onRetry={() => void refetch()} />
      ) : isPending ? (
        <Loading />
      ) : data.length === 0 ? (
        query ? (
          <Empty icon={MagnifyingGlassIcon} title="没有相关的记忆">
            换个说法再搜一次。
          </Empty>
        ) : (
          <Empty icon={BrainIcon} title="还没有记忆">
            对话中值得长期记住的事实会在每轮结束后自动记下。
          </Empty>
        )
      ) : (
        // Keyed so another agent or search starts on its first page.
        <MemoryList
          key={`${current.id}\n${query}`}
          agentId={current.id}
          memories={data}
        />
      )}
    </div>
  );
}
