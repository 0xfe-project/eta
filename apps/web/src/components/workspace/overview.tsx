import type { ReactNode } from "react";
import type { Agent, ChatMessage } from "@/queries/chat";
import type { Connection, Model } from "@/queries/llm";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import {
  ACTIVE_STATUSES,
  chatQueryOptions,
  usePendingInteractions,
} from "@/queries/chat";
import {
  NEEDS_ACTION,
  useConnections,
  useModelAvailability,
  useModels,
} from "@/queries/llm";
import { useMemoryCounts } from "@/queries/memory";
import { AgentStatusDot } from "./agent-identity";
import { agentStatusLabels } from "./agent-status";
import { connectionStateLabels, untilText } from "./connection-state";
import { useAgents, useOpenAgent } from "./use-agents";

// An instrument cluster for the workspace, in the app's monochrome: the
// foreground marks what is happening, destructive what needs fixing.

function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

const START = (-135 * Math.PI) / 180;
const SWEEP = (270 * Math.PI) / 180;

/** A point on the dial, `fraction` of the way round, `r` from its center. */
function point(fraction: number, r: number) {
  const angle = START + SWEEP * fraction;
  // Rounded so server and browser render the same digits.
  const round = (n: number) => Math.round(n * 100) / 100;
  return [
    round(90 + r * Math.sin(angle)),
    round(90 - r * Math.cos(angle)),
  ] as const;
}

function arc(from: number, to: number) {
  const [x0, y0] = point(from, 80);
  const [x1, y1] = point(to, 80);
  const large = SWEEP * (to - from) > Math.PI ? 1 : 0;
  return `M ${x0} ${y0} A 80 80 0 ${large} 1 ${x1} ${y1}`;
}

/**
 * A round dial reading `value` (0 to 1) against evenly spaced `labels`, with
 * an optional red zone from `redFrom` to the end.
 */
function Gauge({
  value,
  labels,
  redFrom,
  label,
  children,
}: {
  value: number;
  labels: string[];
  redFrom?: number;
  label: string;
  children: ReactNode;
}) {
  const fraction = Math.min(Math.max(value, 0), 1);
  const ticks = (labels.length - 1) * 5;
  const [n0x, n0y] = point(fraction, 62);
  const [n1x, n1y] = point(fraction, 88);
  return (
    <div role="img" aria-label={label} className="relative">
      <svg viewBox="0 0 180 180" className="w-full" aria-hidden="true">
        <path
          d={arc(0, 1)}
          className="fill-none stroke-muted"
          strokeWidth={6}
        />
        {redFrom === undefined ? null : (
          <path
            d={arc(redFrom, 1)}
            className="fill-none stroke-destructive/35"
            strokeWidth={6}
          />
        )}
        {fraction > 0 ? (
          <path
            d={arc(0, fraction)}
            className="fill-none stroke-foreground"
            strokeWidth={6}
          />
        ) : null}
        {Array.from({ length: ticks + 1 }, (_, i) => {
          const f = i / ticks;
          const major = i % 5 === 0;
          const [x0, y0] = point(f, major ? 64 : 68);
          const [x1, y1] = point(f, 72);
          const [tx, ty] = point(f, 54);
          return (
            <g key={i}>
              <line
                x1={x0}
                y1={y0}
                x2={x1}
                y2={y1}
                strokeWidth={major ? 1.5 : 1}
                className={
                  redFrom !== undefined && f > redFrom
                    ? "stroke-destructive"
                    : major
                      ? "stroke-chart-2"
                      : "stroke-chart-1"
                }
              />
              {major ? (
                <text
                  x={tx}
                  y={ty + 3}
                  textAnchor="middle"
                  className="fill-muted-foreground font-mono text-[8.5px]"
                >
                  {labels[i / 5]}
                </text>
              ) : null}
            </g>
          );
        })}
        <line
          x1={n0x}
          y1={n0y}
          x2={n1x}
          y2={n1y}
          strokeWidth={2.5}
          className="stroke-destructive"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center pb-[18%]">
        {children}
      </div>
    </div>
  );
}

function Caption({ children }: { children: ReactNode }) {
  return (
    <span className="font-mono text-[10px] tracking-widest text-muted-foreground">
      {children}
    </span>
  );
}

/** Odometer-style digits; `—` until the number is known. */
function Digits({
  value,
  width,
  strong = false,
}: {
  value: number | undefined;
  width: number;
  strong?: boolean;
}) {
  const text = value === undefined ? "—" : String(value).padStart(width, "0");
  return (
    <span className="mt-1 inline-flex gap-px font-mono text-[13px] tabular-nums">
      {Array.from(text, (digit, i) => (
        <span
          key={i}
          className={cn(
            "px-1",
            strong ? "bg-foreground text-card" : "bg-muted text-foreground",
          )}
        >
          {digit}
        </span>
      ))}
    </span>
  );
}

const hatch = (color: string) => ({
  background: `repeating-linear-gradient(135deg, ${color} 0 3px, transparent 3px 6px)`,
});

function connectionCell(connection: Connection) {
  if (connection.state === "active") return { className: "bg-foreground" };
  if (NEEDS_ACTION.has(connection.state))
    return { className: "bg-destructive" };
  if (connection.state === "rate_limited")
    return { style: hatch("var(--muted-foreground)") };
  return { className: "bg-muted" };
}

/** One segment per account, like a fuel gauge. */
function AccountsGauge({
  connections = [],
  loading,
}: {
  connections: Connection[] | undefined;
  loading: boolean;
}) {
  const active = connections.filter((c) => c.state === "active").length;
  const broken = connections.find((c) => NEEDS_ACTION.has(c.state));
  const limited = connections.find((c) => c.state === "rate_limited");
  const note = loading
    ? "读取中…"
    : broken
      ? `${broken.label} ${connectionStateLabels[broken.state]}`
      : limited
        ? [
            `${limited.label} ${connectionStateLabels.rate_limited}`,
            untilText(limited.retry_at),
          ]
            .filter(Boolean)
            .join(" · ")
        : connections.length
          ? "全部正常"
          : "还没有账号";
  return (
    <Meter
      title="模型账号"
      reading={loading ? "—" : `${active} / ${connections.length} 可用`}
      ends={["E", "F"]}
      note={note}
      alert={Boolean(broken)}
    >
      {connections.map((connection) => (
        <i
          key={connection.id}
          title={`${connection.label}：${connectionStateLabels[connection.state]}`}
          {...connectionCell(connection)}
        />
      ))}
    </Meter>
  );
}

function ModelsGauge({
  models = [],
  loading,
}: {
  models: Model[] | undefined;
  loading: boolean;
}) {
  const available = models.filter((model) => model.available).length;
  const unavailable = models.length - available;
  return (
    <Meter
      title="模型目录"
      reading={loading ? "—" : `${available} / ${models.length} 可用`}
      ends={["0", String(models.length)]}
      note={
        loading
          ? "读取中…"
          : unavailable
            ? `${unavailable} 个不可用`
            : models.length
              ? "全部可用"
              : "没有模型"
      }
    >
      {models.map((model) => (
        <i
          key={model.id}
          title={
            model.available
              ? model.display_name
              : `${model.display_name}：${model.unavailable_reason?.message ?? "不可用"}`
          }
          className={model.available ? "bg-foreground" : undefined}
          style={model.available ? undefined : hatch("var(--muted-foreground)")}
        />
      ))}
    </Meter>
  );
}

function Meter({
  title,
  reading,
  ends,
  note,
  alert = false,
  children,
}: {
  title: string;
  reading: string;
  ends: [string, string];
  note: string;
  alert?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <Caption>{title}</Caption>
        <span className="font-mono text-[11px] tabular-nums">{reading}</span>
      </div>
      <div className="flex h-2.5 gap-0.5 empty:bg-muted [&>i]:flex-1">
        {children}
      </div>
      <div className="mt-1 flex justify-between gap-2 font-mono text-[10px] text-muted-foreground">
        <span>{ends[0]}</span>
        <span className={cn("min-w-0 truncate", alert && "text-destructive")}>
          {note}
        </span>
        <span>{ends[1]}</span>
      </div>
    </div>
  );
}

// P parks an idle agent, N holds one waiting on the user, D drives a turn
// (or gets the agent going for one).
const gears: { gear: string; statuses: Agent["status"][] }[] = [
  { gear: "P", statuses: ["idle"] },
  { gear: "N", statuses: ["waiting_for_input"] },
  { gear: "D", statuses: ["starting", "working"] },
];

function contextText(tokens: number | undefined) {
  if (!tokens) return "—";
  return tokens >= 1_000_000
    ? `${tokens / 1_000_000}M`
    : `${Math.round(tokens / 1000)}K`;
}

/** The current agent: its gear, model and whether the model can run. */
function Display({
  agent,
  loading,
}: {
  agent: Agent | undefined;
  loading: boolean;
}) {
  const availability = useModelAvailability(agent);
  const model =
    availability.state === "not_set" ? undefined : availability.model;
  return (
    <div className="flex h-full min-h-36 flex-col justify-between bg-muted p-2.5 text-center">
      <div className="font-mono text-[11px] tracking-[0.2em] text-muted-foreground">
        {gears.map(({ gear, statuses }) => (
          <span
            key={gear}
            className={cn(
              "px-1",
              agent &&
                statuses.includes(agent.status) &&
                "bg-foreground text-card",
            )}
          >
            {gear}
          </span>
        ))}
      </div>
      {agent ? (
        <>
          <div className="min-w-0">
            <div className="truncate font-semibold">{agent.name}</div>
            <div className="truncate font-mono text-[10px] text-muted-foreground">
              {model?.display_name ?? agent.model ?? "未选择模型"} ·{" "}
              {agentStatusLabels[agent.status]}
            </div>
          </div>
          <Row label="上下文窗口">{contextText(model?.context_window)}</Row>
          <Row label="模型">
            {availability.state === "ok" ? (
              <span className="text-foreground">■ 可用</span>
            ) : availability.state === "unavailable" ? (
              <span className="text-destructive">■ 不可用</span>
            ) : (
              "未选择"
            )}
          </Row>
        </>
      ) : loading ? (
        <div className="text-sm text-muted-foreground motion-safe:animate-pulse">
          读取中…
        </div>
      ) : (
        <div className="text-sm text-muted-foreground">还没有智能体</div>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-2 font-mono text-[10px] text-muted-foreground">
      <span>{label}</span>
      <span className="tabular-nums">{children}</span>
    </div>
  );
}

/** Labels for a 0..n dial; spaced out so a big fleet still reads. */
function loadScale(agents: number) {
  const step = Math.max(1, Math.ceil(agents / 8));
  const max = Math.max(step, step * Math.ceil(agents / step));
  return {
    max,
    labels: Array.from({ length: max / step + 1 }, (_, i) => String(i * step)),
  };
}

/** Labels for the turn timer: five minutes, widened in five-minute steps. */
function timerScale(seconds: number) {
  const minutes = 5 * Math.max(1, Math.ceil(seconds / 300));
  return {
    max: minutes * 60,
    labels: Array.from({ length: 6 }, (_, i) =>
      i ? `${(minutes / 5) * i}m` : "0",
    ),
  };
}

function clock(seconds: number) {
  const s = Math.floor(seconds % 60);
  const m = Math.floor(seconds / 60);
  return m >= 60
    ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

/** The reply the agent is on now: the oldest that has started. */
function currentReply(messages: ChatMessage[], agentId: string | undefined) {
  return messages.find(
    (message) =>
      message.agent_id === agentId &&
      message.role === "assistant" &&
      message.status !== "queued" &&
      ACTIVE_STATUSES.has(message.status),
  );
}

export function Overview() {
  const now = useNow();
  const { data: snapshot } = useQuery(chatQueryOptions());
  const { agents, current } = useAgents();
  const openAgent = useOpenAgent();
  const pending = usePendingInteractions();
  const connectionList = useConnections();
  const modelList = useModels();
  const models = modelList.data ?? [];
  // Until the snapshot lands the instruments read "—", not zero.
  const loaded = snapshot !== undefined;
  const memories = useMemoryCounts(agents.map((agent) => agent.id));

  const count = (status: Agent["status"]) =>
    agents.filter((agent) => agent.status === status).length;
  const working = count("starting") + count("working");
  const waiting = count("waiting_for_input");
  const load = loadScale(agents.length);

  const messages = snapshot?.messages ?? [];
  const replies = messages.filter(
    (message) =>
      message.role === "assistant" && ACTIVE_STATUSES.has(message.status),
  ).length;
  const reply = currentReply(messages, current?.id);
  const elapsed = reply
    ? Math.max(0, (now - new Date(reply.created_at).getTime()) / 1000)
    : 0;
  const timer = timerScale(elapsed);

  return (
    <section
      aria-label="概览"
      aria-busy={!loaded}
      className="mx-auto max-w-2xl border p-3.5 text-foreground"
    >
      <div className="grid grid-cols-[1fr_minmax(8rem,10rem)_1fr] items-center gap-1">
        <div>
          <Gauge
            value={(working + waiting) / load.max}
            labels={load.labels}
            redFrom={0.9}
            label={`负载：${agents.length} 个智能体中 ${working + waiting} 个在运转`}
          >
            <span className="font-mono text-[2.25rem] leading-none font-semibold tracking-tight tabular-nums">
              {loaded ? working + waiting : "—"}
              <span className="text-lg text-muted-foreground">
                /{loaded ? agents.length : "—"}
              </span>
            </span>
            <span className="mt-1.5">
              <Caption>负载 · 运转中</Caption>
            </span>
          </Gauge>
          <p className="-mt-3 text-center font-mono text-[10px] text-muted-foreground">
            {loaded ? working : "—"} 工作中 · {loaded ? waiting : "—"} 等待确认
          </p>
        </div>

        <Display agent={current} loading={!loaded} />

        <div>
          <Gauge
            value={elapsed / timer.max}
            labels={timer.labels}
            label={
              reply
                ? `本轮已用 ${clock(elapsed)}`
                : "当前智能体没有进行中的回复"
            }
          >
            <span
              suppressHydrationWarning
              className="font-mono text-3xl leading-none font-semibold tracking-tight tabular-nums"
            >
              {reply ? clock(elapsed) : "—"}
            </span>
            <span className="mt-1.5">
              <Caption>本轮计时</Caption>
            </span>
          </Gauge>
          <p className="-mt-3 text-center font-mono text-[10px] text-muted-foreground">
            {reply ? "回复中" : "未在回复"} · {loaded ? replies : "—"} 条进行中
          </p>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-4">
        <AccountsGauge
          connections={connectionList.data}
          loading={connectionList.isPending}
        />
        <ModelsGauge models={modelList.data} loading={modelList.isPending} />
      </div>

      {agents.length ? (
        <ul aria-label="智能体" className="mt-3.5 grid gap-0.5 border-t pt-2">
          {agents.map((agent) => {
            const memoryCount = memories.byAgent.get(agent.id);
            return (
              <li key={agent.id}>
                <button
                  type="button"
                  onClick={() => openAgent(agent.id)}
                  className={cn(
                    "grid w-full grid-cols-[auto_1fr_auto_4rem_4rem] items-center gap-2 px-1 py-1 text-left text-xs hover:bg-muted",
                    agent.id === current?.id && "bg-muted",
                  )}
                >
                  <AgentStatusDot status={agent.status} className="size-2" />
                  <span className="truncate">{agent.name}</span>
                  <span className="truncate font-mono text-[10px] text-muted-foreground">
                    {models.find((model) => model.id === agent.model)
                      ?.display_name ??
                      agent.model ??
                      "未选择模型"}
                  </span>
                  <span className="text-right font-mono text-[10px] text-muted-foreground tabular-nums">
                    {memoryCount ?? "—"} 记忆
                  </span>
                  <span className="text-right font-mono text-[10px] text-muted-foreground">
                    {agentStatusLabels[agent.status]}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      <div className="mt-3.5 flex items-end justify-between border-t pt-2.5">
        <div className="flex flex-col">
          <Caption>智能体</Caption>
          <Digits value={loaded ? agents.length : undefined} width={2} strong />
        </div>
        <div className="flex flex-col items-center">
          <Caption>待确认</Caption>
          <Digits value={loaded ? pending.length : undefined} width={2} />
        </div>
        <div className="flex flex-col items-end">
          <Caption>记忆条目</Caption>
          <Digits value={loaded ? memories.total : undefined} width={4} />
        </div>
      </div>
    </section>
  );
}
