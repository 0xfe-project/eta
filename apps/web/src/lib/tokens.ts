import { formatLocale } from "@/lib/i18n";

/** 12,345 → "1.2万"; tokens read best in 万 and 亿. */
export function tokens(n: number) {
  return new Intl.NumberFormat(formatLocale(), {
    notation: "compact",
    maximumFractionDigits: 1,
    minimumFractionDigits: formatLocale() === "zh-CN" && n >= 1e4 ? 1 : 0,
  }).format(n);
}
