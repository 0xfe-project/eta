import type { Memory } from "@/queries/memory";
import { BrainIcon } from "@phosphor-icons/react/Brain";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/MagnifyingGlass";
import { TrashIcon } from "@phosphor-icons/react/Trash";
import { useEffect, useState } from "react";
import { toast } from "sonner";
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
  const { current, loaded } = useAgents();
  const [search, setSearch] = useState("");
  const query = useDebounced(search.trim());
  const { data, error, isPending } = useMemories(current?.id, query);

  if (!current)
    return loaded ? (
      <p className="py-10 text-center text-sm text-muted-foreground">
        还没有智能体
      </p>
    ) : null;

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
        <div className="relative w-48 shrink-0">
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
      <RememberForm agentId={current.id} />
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error.message}
        </p>
      ) : isPending ? (
        <p className="text-sm text-muted-foreground">正在加载…</p>
      ) : data.length === 0 ? (
        <div className="flex flex-col items-center gap-2 border border-dashed px-6 py-10 text-center">
          <BrainIcon
            aria-hidden="true"
            className="size-8 text-muted-foreground"
          />
          <p className="text-sm font-medium">
            {query ? "没有相关的记忆" : "还没有记忆"}
          </p>
          {query ? null : (
            <p className="text-xs text-muted-foreground">
              对话中值得长期记住的事实会在每轮结束后自动记下。
            </p>
          )}
        </div>
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
