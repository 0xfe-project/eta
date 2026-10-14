import * as React from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

/**
 * ClaudeDiff — Claude Code's inline edit hunk (the ⏺ Update / ⎿ summary + the
 * +/- lines). Added/removed rows carry semantic tinted backgrounds and an
 * off-screen "added"/"removed" label so the diff is legible without color.
 */
export interface DiffLine {
  type: "add" | "del" | "ctx";
  n?: number;
  text: string;
}

const GREEN = "var(--terminal-success)";

export function ClaudeDiff({
  file,
  summary,
  lines,
  className,
}: {
  file: string;
  summary?: string;
  lines: DiffLine[];
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <div
      className={cn("min-w-0 font-mono text-[13px] leading-[1.55]", className)}
    >
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        <span aria-hidden className="shrink-0" style={{ color: GREEN }}>
          ⏺
        </span>
        <span className="text-[var(--terminal-claude-foreground)]">
          {t("更新")}
        </span>
        <span className="min-w-0 break-all">
          <span className="text-[var(--terminal-muted)]">(</span>
          <span className="text-[var(--terminal-link)]">{file}</span>
          <span className="text-[var(--terminal-muted)]">)</span>
        </span>
      </div>
      {summary ? (
        <div className="flex min-w-0 items-baseline gap-2 text-[var(--terminal-muted)]">
          {/* invisible status glyph spacer: aligns ⎿ under "Update" */}
          <span aria-hidden className="invisible shrink-0">
            ⏺
          </span>
          <span
            aria-hidden
            className="shrink-0"
            style={{ color: "var(--terminal-muted)" }}
          >
            ⎿
          </span>
          <span className="min-w-0 break-words">{summary}</span>
        </div>
      ) : null}

      <pre className="mt-1 min-w-0 overflow-x-auto rounded-none border border-[var(--terminal-border)] bg-[var(--terminal-code-background)] py-1.5 pl-2 pr-3">
        {lines.map((l, i) => {
          const bg =
            l.type === "add"
              ? "var(--terminal-diff-added)"
              : l.type === "del"
                ? "var(--terminal-diff-removed)"
                : "transparent";
          const mark = l.type === "add" ? "+" : l.type === "del" ? "-" : " ";
          const markColor =
            l.type === "add"
              ? GREEN
              : l.type === "del"
                ? "var(--terminal-error)"
                : "var(--terminal-muted)";
          return (
            <div key={i} className="flex min-w-0" style={{ background: bg }}>
              <span
                className="w-9 shrink-0 select-none pr-2 text-right"
                style={{ color: "var(--terminal-muted)" }}
              >
                {l.n ?? ""}
              </span>
              <span
                className="w-3 shrink-0 select-none"
                style={{ color: markColor }}
              >
                {mark}
              </span>
              <span
                className="min-w-0 break-all"
                style={{
                  color:
                    l.type === "ctx"
                      ? "var(--terminal-muted)"
                      : "var(--terminal-claude-foreground)",
                }}
              >
                {l.type !== "ctx" ? (
                  <span className="sr-only">
                    {l.type === "add" ? t("新增：") : t("移除：")}
                  </span>
                ) : null}
                {l.text}
              </span>
            </div>
          );
        })}
      </pre>
    </div>
  );
}
