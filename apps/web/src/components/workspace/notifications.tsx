import type { Interaction } from "@/queries/chat";
import { BellIcon } from "@phosphor-icons/react/Bell";
import { parseAsStringLiteral, useQueryState } from "nuqs";
import { toast } from "sonner";
import { Empty, LoadError, Loading } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { useAnswerInteraction, useInteractionHistory } from "@/queries/chat";
import { AgentAvatar } from "./agent-identity";
import { PageHeader } from "./app-shell";
import { AttentionList } from "./attention";
import { useAgents, useOpenAgent } from "./use-agents";

// Confirmations as notifications: the ones waiting on the user to answer
// in place, then what was asked before and how it was answered.

const filterParser = parseAsStringLiteral(["all", "pending"] as const)
  .withDefault("all")
  .withOptions({ history: "push" });

/** "今天", "昨天", "10月6日". */
function day(iso: string) {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "今天";
  if (date.toDateString() === yesterday.toDateString()) return "昨天";
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

function clock(iso: string) {
  return new Date(iso).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** How an answered or lapsed confirmation ended. */
function outcome(interaction: Interaction) {
  const chosen = interaction.options.find(
    (option) => option.value === interaction.answer,
  );
  if (chosen) return `已选择「${chosen.label}」`;
  if (interaction.status === "expired") return "已过期，没有答复";
  return "已答复";
}

function Item({ interaction }: { interaction: Interaction }) {
  const { agents } = useAgents();
  const openAgent = useOpenAgent();
  const answer = useAnswerInteraction();
  const agent = agents.find((a) => a.id === interaction.agent_id);
  const pending = interaction.status === "pending";
  return (
    <li className="flex gap-3 border-b px-4 py-3 sm:px-6">
      <AgentAvatar
        agent={agent ?? { id: interaction.agent_id }}
        className="size-7"
      />
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex items-baseline gap-2">
          <button
            type="button"
            onClick={() => openAgent(interaction.agent_id)}
            className="truncate text-sm font-medium underline-offset-4 outline-none hover:underline focus-visible:underline"
          >
            {agent?.name ?? "已删除的智能体"}
          </button>
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {clock(interaction.created_at)}
          </span>
          {pending ? (
            <span
              role="img"
              aria-label="待处理"
              className="ml-auto size-1.5 shrink-0 self-center bg-foreground"
            />
          ) : null}
        </div>
        <p
          className={cn(
            "text-sm break-words whitespace-pre-wrap",
            !pending && "line-clamp-3 text-muted-foreground",
          )}
        >
          {interaction.prompt}
        </p>
        {pending ? (
          <div className="flex flex-wrap gap-2 pt-0.5">
            {interaction.options.map((option, index) => (
              <Button
                key={option.value}
                size="sm"
                variant={index === 0 ? "default" : "outline"}
                disabled={answer.isPending}
                onClick={() =>
                  answer.mutate(
                    { id: interaction.id, value: option.value },
                    { onError: (error) => toast.error(error.message) },
                  )
                }
              >
                {option.label}
              </Button>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            {outcome(interaction)}
          </p>
        )}
      </div>
    </li>
  );
}

/** Every agent's confirmations, grouped by day, the waiting ones marked. */
export function Notifications() {
  const [filter, setFilter] = useQueryState("filter", filterParser);
  const { interactions, isPending, error, refetch } = useInteractionHistory();
  const shown = interactions.filter(
    (i) => filter === "all" || i.status === "pending",
  );
  const days = new Map<string, Interaction[]>();
  for (const interaction of shown) {
    const label = day(interaction.created_at);
    days.set(label, [...(days.get(label) ?? []), interaction]);
  }
  return (
    <>
      <PageHeader title="待处理">
        <Tabs
          value={filter}
          onValueChange={(value) => void setFilter(value as typeof filter)}
        >
          <TabsList aria-label="筛选" className="gap-1">
            <TabsTrigger value="all" className="px-2 text-xs">
              全部
            </TabsTrigger>
            <TabsTrigger value="pending" className="px-2 text-xs">
              待处理
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </PageHeader>
      <main id="main" className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl">
          <div className="px-4 pt-4 sm:px-6 [&:not(:has(ul))]:hidden">
            <AttentionList />
          </div>
          {error ? (
            <div className="px-4 py-16 sm:px-6">
              <LoadError
                what="确认记录"
                error={error}
                onRetry={() => void refetch()}
              />
            </div>
          ) : isPending ? (
            <Loading rows={5} className="px-2 py-4 sm:px-4" />
          ) : shown.length === 0 ? (
            <div className="px-4 py-16 sm:px-6">
              <Empty
                icon={BellIcon}
                title={
                  filter === "pending" ? "没有待处理的确认" : "还没有确认请求"
                }
              >
                智能体要做需要你批准的操作时，会在这里等你答复。
              </Empty>
            </div>
          ) : (
            [...days].map(([label, items]) => (
              <section key={label} aria-label={label}>
                <h2 className="sticky top-0 z-10 bg-background px-4 pt-4 pb-1 text-xs font-medium text-muted-foreground sm:px-6">
                  {label}
                </h2>
                <ul>
                  {items.map((interaction) => (
                    <Item key={interaction.id} interaction={interaction} />
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>
      </main>
    </>
  );
}
