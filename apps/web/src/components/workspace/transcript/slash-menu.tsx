import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

export interface SlashRow {
  /** What gets inserted: `/compact`, `@乐子人`, `@src/app.ts`, `#10`. */
  name: string;
  description: string;
  /** A task row shows its status icon before the number; nothing else has one. */
  icon?: ReactNode;
  /** ...and the status word after the title, so a finished task is not picked by mistake. */
  status?: string;
  /**
   * What a screen reader reads for the row. The visible text is split into columns, so a task
   * row says it out in one sentence instead: `#10 Tidy up the release notes · Pending acceptance`.
   */
  ariaLabel?: string;
}

/**
 * The completion menu above the composer: one row per candidate, the name in mono and the
 * description dimmed beside it, the selected row inverted. Ported from eta-old's
 * `.skill-slash-menu` rather than rethought — a menu is not the place for a second idea.
 */
export function SlashMenu({
  id,
  rows,
  active,
  label,
  onChoose,
  onHover,
}: {
  id: string;
  rows: readonly SlashRow[];
  active: number;
  /** What the strip above the rows calls the list: commands, mentions, tasks. */
  label?: string;
  onChoose: (row: SlashRow) => void;
  onHover: (index: number) => void;
}) {
  const { t: translateText } = useTranslation("chat");
  const heading = label ?? translateText("composer.commandsLabel");
  return (
    <div
      className="skill-slash-menu"
      role="listbox"
      id={id}
      aria-label={heading}
    >
      <div className="skill-slash-indicator">{heading}</div>
      {rows.length === 0 ? (
        <p className="skill-slash-empty">
          {translateText("composer.noMatches")}
        </p>
      ) : (
        rows.map((row, index) => (
          <button
            key={row.name}
            type="button"
            role="option"
            id={`${id}-${index}`}
            aria-selected={index === active}
            aria-label={row.ariaLabel}
            className={cn("skill-slash-option", index === active && "selected")}
            onMouseEnter={() => onHover(index)}
            onClick={() => onChoose(row)}
          >
            {row.icon}
            <span className="skill-slash-option-name">{row.name}</span>
            <span className="skill-slash-option-desc">{row.description}</span>
            {row.status !== undefined && (
              <span className="skill-slash-option-status">{row.status}</span>
            )}
          </button>
        ))
      )}
    </div>
  );
}
