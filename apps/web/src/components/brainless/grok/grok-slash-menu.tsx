"use client";

import { cn } from "@/lib/utils";

/**
 * GrokSlashMenu — Grok CLI's slash-command palette.
 *
 * Overlay above the rounded composer: active row marked with `❯`, inactive
 * rows indented. The GrokPrompt input filters it and moves the selection.
 */
export interface GrokSlashCommand {
  name: string;
  description: string;
}

const ACTIVE = "var(--terminal-foreground)";
const INACTIVE = "var(--terminal-muted)";
const RULE = "var(--terminal-border)";
const NAME_COLS = 16;

export function GrokSlashMenu({
  id,
  commands,
  active,
  onActiveChange,
  onChoose,
  className,
}: {
  /** Listbox id; options are `${id}-${index}`. */
  id: string;
  commands: GrokSlashCommand[];
  active: number;
  onActiveChange: (index: number) => void;
  onChoose: (command: GrokSlashCommand) => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "mb-2 border-y py-1.5 font-mono text-[13px] leading-[1.55]",
        className,
      )}
      style={{ borderColor: RULE }}
    >
      <ul id={id} role="listbox" aria-label="斜杠命令" className="space-y-0.5">
        {commands.map((c, i) => {
          const activeRow = i === active;
          return (
            <li
              key={c.name}
              id={`${id}-${i}`}
              role="option"
              aria-selected={activeRow}
              onMouseEnter={() => onActiveChange(i)}
              // Keep focus in the composer.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onChoose(c)}
              className="flex cursor-pointer items-baseline gap-2 truncate px-1"
              style={{ color: activeRow ? ACTIVE : INACTIVE }}
            >
              <span
                aria-hidden
                className="inline-block w-[2ch] shrink-0"
                style={{ color: activeRow ? ACTIVE : "transparent" }}
              >
                ❯
              </span>
              <span
                className="inline-block shrink-0"
                style={{ width: `${NAME_COLS}ch` }}
              >
                {c.name}
              </span>
              <span className="min-w-0 truncate">{c.description}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
