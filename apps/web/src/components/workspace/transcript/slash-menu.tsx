import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

export interface SlashRow {
  /** What gets inserted: `/compact`, `@乐子人`, `@src/app.ts`. */
  name: string;
  description: string;
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
  onChoose,
  onHover,
}: {
  id: string;
  rows: readonly SlashRow[];
  active: number;
  onChoose: (row: SlashRow) => void;
  onHover: (index: number) => void;
}) {
  const { t: translateText } = useTranslation("chat");
  return (
    <div
      className="skill-slash-menu"
      role="listbox"
      id={id}
      aria-label={translateText("composer.commandsLabel")}
    >
      <div className="skill-slash-indicator">
        {translateText("composer.commandsLabel")}
      </div>
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
            className={cn("skill-slash-option", index === active && "selected")}
            onMouseEnter={() => onHover(index)}
            onClick={() => onChoose(row)}
          >
            <span className="skill-slash-option-name">{row.name}</span>
            <span className="skill-slash-option-desc">{row.description}</span>
          </button>
        ))
      )}
    </div>
  );
}
