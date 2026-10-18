import { useTranslation } from "react-i18next";
import { formatLocale } from "@/lib/i18n";
import { useAgentUsage } from "@/queries/usage";

/** 12,345 → "1.2万"; tokens read best in 万 and 亿. */
function tokens(n: number) {
  return new Intl.NumberFormat(formatLocale(), {
    notation: "compact",
    maximumFractionDigits: 1,
    minimumFractionDigits: formatLocale() === "zh-CN" && n >= 1e4 ? 1 : 0,
  }).format(n);
}

const WINDOWS = [
  ["5h", "common:time.windows.fiveHours"],
  ["24h", "common:time.windows.day"],
  ["7d", "common:time.windows.week"],
] as const;

/** An agent's model usage, as the host counts it: tokens over the last 5 hours, day and week. */
export function UsageLine({ agentId }: { agentId: string }) {
  const { t: translateText } = useTranslation(["agents", "common"] as const);
  const { usage, loaded } = useAgentUsage(agentId);
  if (!loaded) return null;
  const week = usage?.windows["7d"];
  return (
    <p className="text-xs text-muted-foreground tabular-nums">
      {translateText("usage.summary", {
        usage: week?.requests
          ? translateText("usage.tokensAndRequests", {
              tokens: WINDOWS.map(
                ([key, label]) =>
                  `${translateText(label)} ${tokens(usage?.windows[key]?.total ?? 0)}`,
              ).join(" · "),
              count: week.requests,
            })
          : translateText("usage.noRecentUsage"),
      })}
    </p>
  );
}
