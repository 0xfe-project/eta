import { useTranslation } from "react-i18next";
import { formatLocale } from "@/lib/i18n";
import { useAgentUsage } from "@/queries/llm";

/** 12,345 → "1.2万"; tokens read best in 万 and 亿. */
function tokens(n: number) {
  return new Intl.NumberFormat(formatLocale(), {
    notation: "compact",
    maximumFractionDigits: 1,
    minimumFractionDigits: formatLocale() === "zh-CN" && n >= 1e4 ? 1 : 0,
  }).format(n);
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
  const { t: translateText } = useTranslation();
  const { data: usage, isPending } = useAgentUsage(principal);
  if (isPending) return null;
  const week = usage?.windows["7d"];
  return (
    <p className="text-xs text-muted-foreground tabular-nums">
      {translateText("模型用量：{{value1}}", {
        value1: week?.requests
          ? translateText("{{value1}} tokens（7 天 {{value2}} 次请求）", {
              value1: WINDOWS.map(
                ([key, label]) =>
                  `${translateText(label)} ${tokens(usage?.windows[key]?.total_tokens ?? 0)}`,
              ).join(" · "),
              value2: week.requests,
              count: week.requests,
            })
          : translateText("近 7 天没有"),
      })}
    </p>
  );
}
