import { useAgentUsage } from "@/queries/llm";

/** 12,345 → "1.2万"; tokens read best in 万 and 亿. */
function tokens(n: number) {
  if (n >= 1e8) return `${(n / 1e8).toFixed(1)}亿`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(1)}万`;
  return n.toLocaleString();
}

const WINDOWS = [
  ["5h", "5 小时"],
  ["24h", "24 小时"],
  ["7d", "7 天"],
] as const;

/**
 * A chat agent's or a routine's model usage, as the LLM gateway counts it:
 * tokens over the last 5 hours, day and week.
 */
export function UsageLine({ principal }: { principal: string }) {
  const { data: usage, isPending } = useAgentUsage(principal);
  if (isPending) return null;
  const week = usage?.windows["7d"];
  return (
    <p className="text-xs text-muted-foreground tabular-nums">
      模型用量：
      {week?.requests
        ? `${WINDOWS.map(
            ([key, label]) =>
              `${label} ${tokens(usage?.windows[key]?.total_tokens ?? 0)}`,
          ).join(" · ")} tokens（7 天 ${week.requests} 次请求）`
        : "近 7 天没有"}
    </p>
  );
}
