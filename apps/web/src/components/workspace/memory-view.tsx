import type { Memory } from "@/queries/memory";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/ArrowClockwise";
import { BrainIcon } from "@phosphor-icons/react/Brain";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/MagnifyingGlass";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { RobotIcon } from "@phosphor-icons/react/Robot";
import { TrashIcon } from "@phosphor-icons/react/Trash";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Empty, LoadError, Loading } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useForget, useMemories, useRemember } from "@/queries/memory";
import { useAgents } from "./use-agents";

// Each search embeds the query; wait for the user to stop typing.
const SEARCH_DELAY_MS = 300;

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
  return (
    <li className="group flex items-start gap-2 px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="text-sm break-words whitespace-pre-wrap">{memory.text}</p>
        {memory.created_at ? (
          <p className="text-xs text-muted-foreground tabular-nums">
            {date(memory.created_at)}
          </p>
        ) : null}
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="忘记这条记忆"
        title="忘记"
        disabled={forget.isPending}
        className="opacity-60 group-hover:opacity-100 focus-visible:opacity-100"
        onClick={() =>
          forget.mutate(memory.id, {
            onError: (error) => toast.error(error.message),
          })
        }
      >
        <TrashIcon aria-hidden="true" />
      </Button>
    </li>
  );
}

/** The current agent's long-term memories: browse, search, add and forget. */
export function MemoryView() {
  const {
    current,
    loaded,
    error: agentsError,
    retry,
    openEditor,
  } = useAgents();
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
        <h2 className="min-w-0 truncate text-sm font-semibold">
          {current.name} 的记忆
          {data && !query ? (
            <span className="ml-1.5 font-normal tabular-nums text-muted-foreground">
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
        <ul aria-label="记忆列表" className="divide-y border">
          {data.map((memory) => (
            <MemoryRow key={memory.id} agentId={current.id} memory={memory} />
          ))}
        </ul>
      )}
    </div>
  );
}
