import type { Memory, MemorySource } from "@/queries/memory";

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
import { useQuery } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Empty, LoadError, Loading } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatLocale, translate } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { chatQueryOptions } from "@/queries/chat";
import { useForget, useMemories, useRemember } from "@/queries/memory";
import { Select, SelectOption } from "./select-field";
import { ago } from "./task-format";
import { useAgents } from "./use-agents";

// Each search embeds the query; wait for the user to stop typing.
const SEARCH_DELAY_MS = 300;
const PAGE_SIZE = 20;

const sources = {
  conversation: {
    icon: ChatCircleDotsIcon,
    get label() {
      return translate("memory:source.conversation");
    },
  },
  agent: {
    icon: RobotIcon,
    get label() {
      return translate("memory:source.agent");
    },
  },
  user: {
    icon: UserIcon,
    get label() {
      return translate("memory:source.manual");
    },
  },
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
  return new Date(iso).toLocaleString(formatLocale(), {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function RememberForm({ agentId }: { agentId: string }) {
  const { t: translateText } = useTranslation([
    "memory",
    "agents",
    "common",
    "navigation",
  ] as const);
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
        aria-label={translateText("create.title")}
        placeholder={translateText("create.placeholder")}
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
        {translateText("actions.remember")}
      </Button>
    </form>
  );
}

function MemoryRow({ agentId, memory }: { agentId: string; memory: Memory }) {
  const { t: translateText } = useTranslation([
    "memory",
    "agents",
    "common",
    "navigation",
  ] as const);
  const forget = useForget(agentId);
  const { data: groupName } = useQuery({
    ...chatQueryOptions(),
    select: (snapshot) =>
      snapshot.groups?.find((group) => group.id === memory.source_group_id)
        ?.name,
  });
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
        {memory.source_group_id && (
          <a
            className="max-w-32 truncate underline underline-offset-2"
            href={`/?group=${encodeURIComponent(memory.source_group_id)}`}
          >
            {groupName || translateText("source.group")}
          </a>
        )}
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
            {expanded
              ? translateText("common:actions.collapse")
              : translateText("common:actions.expand")}
          </button>
        ) : null}
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={translateText("actions.forgetLabel")}
          title={translateText("actions.forget")}
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
  const { t: translateText } = useTranslation([
    "memory",
    "agents",
    "common",
    "navigation",
  ] as const);
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
      <ul
        ref={listRef}
        aria-label={translateText("accessibility.list")}
        className="divide-y border"
      >
        {memories
          .slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE)
          .map((memory) => (
            <MemoryRow key={memory.id} agentId={agentId} memory={memory} />
          ))}
      </ul>
      {pages > 1 ? (
        <nav
          aria-label={translateText("accessibility.pagination")}
          className="flex items-center justify-end gap-1 text-xs text-muted-foreground tabular-nums"
        >
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={translateText("common:actions.previousPage")}
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
            aria-label={translateText("common:actions.nextPage")}
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
  const { t: translateText } = useTranslation([
    "memory",
    "agents",
    "common",
    "navigation",
  ] as const);
  const { agents, loaded, error: agentsError, retry, openEditor } = useAgents();
  const current = agents.find((agent) => agent.id === agentId) ?? agents.at(-1);
  const { data: snapshot } = useQuery(chatQueryOptions());
  const [groupId, setGroupId] = useState("");
  const [source, setSource] = useState<MemorySource | "">("");
  const [search, setSearch] = useState("");
  const query = useDebounced(search.trim());
  const { data, error, isPending, isFetching, refetch } = useMemories(
    current?.id,
    query,
    source || undefined,
    groupId || undefined,
  );

  if (agentsError && !loaded)
    return (
      <LoadError
        what={translateText("common:entities.agents")}
        error={agentsError}
        onRetry={retry}
      />
    );
  if (!loaded) return <Loading />;
  if (!current)
    return (
      <Empty
        icon={RobotIcon}
        title={translateText("agents:empty.title")}
        action={
          <Button size="sm" onClick={() => openEditor()}>
            <PlusIcon aria-hidden="true" data-icon="inline-start" />
            {translateText("agents:actions.create")}
          </Button>
        }
      >
        {translateText("empty.noAgentDescription")}
      </Empty>
    );

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <h2 className="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
          {onAgentChange ? (
            <Select
              size="sm"
              aria-label={translateText("common:entities.agents")}
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
          <span className="shrink-0">{translateText("titleSuffix")}</span>
          {data ? (
            <span className="font-normal tabular-nums text-muted-foreground">
              {data.length}
            </span>
          ) : null}
        </h2>
        <div className="flex w-full min-w-0 items-center gap-2 sm:w-auto sm:shrink-0">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={translateText("actions.refreshLabel")}
            title={translateText("common:actions.refresh")}
            disabled={isFetching}
            onClick={() => void refetch()}
          >
            <ArrowClockwiseIcon
              aria-hidden="true"
              className={isFetching ? "animate-spin" : undefined}
            />
          </Button>
          <Select
            aria-label={translateText("filters.typeLabel")}
            value={source}
            onValueChange={(value) => setSource(value as MemorySource | "")}
            className="shrink-0"
          >
            <SelectOption value="">
              {translateText("filters.allTypes")}
            </SelectOption>
            {Object.entries(sources).map(([value, { label }]) => (
              <SelectOption key={value} value={value}>
                {label}
              </SelectOption>
            ))}
          </Select>
          <Select
            aria-label={translateText("source.group")}
            value={groupId}
            onValueChange={setGroupId}
          >
            <SelectOption value="">
              {translateText("filters.allGroups")}
            </SelectOption>
            {snapshot?.groups?.map((g) => (
              <SelectOption key={g.id} value={g.id}>
                {g.name}
              </SelectOption>
            ))}
          </Select>
          <div className="relative min-w-0 flex-1 sm:w-48 sm:flex-none">
            <MagnifyingGlassIcon
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              type="search"
              aria-label={translateText("search.label")}
              placeholder={translateText("common:actions.search")}
              value={search}
              className="pl-7"
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
      </div>
      <RememberForm agentId={current.id} />
      {error ? (
        <LoadError
          what={translateText("navigation:sections.memory")}
          error={error}
          onRetry={() => void refetch()}
        />
      ) : isPending ? (
        <Loading />
      ) : data.length === 0 ? (
        query || source || groupId ? (
          <Empty
            icon={MagnifyingGlassIcon}
            title={translateText("search.emptyTitle")}
          >
            {source
              ? translateText("search.changeTypeHint")
              : translateText("search.changeQueryHint")}
          </Empty>
        ) : (
          <Empty icon={BrainIcon} title={translateText("empty.title")}>
            {translateText("empty.description")}
          </Empty>
        )
      ) : (
        // Agent, search and source changes all start on the first page.
        <MemoryList
          key={`${current.id}\n${query}\n${source}\n${groupId}`}
          agentId={current.id}
          memories={data}
        />
      )}
    </div>
  );
}
