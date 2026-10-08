"use client";

import { cn } from "@/lib/utils";

/**
 * ClaudeSlashMenu — Claude Code's slash-command palette.
 *
 * The command list sits above the ClaudePrompt composer, which owns the
 * input: it filters the list and moves the active option. Active rows are
 * light blue; inactive rows are gray. Both keep the same fixed-width name
 * column so selection never shifts text.
 */
export interface SlashCommand {
  name: string;
  description: string;
}

const ACTIVE = "var(--terminal-link)"; // 38;5;153
const INACTIVE = "var(--terminal-muted)"; // 38;5;246
const NAME_COLS = 37; // matches Claude Code's padded name column

export function ClaudeSlashMenu({
  id,
  commands,
  active,
  onActiveChange,
  onChoose,
  className,
}: {
  /** Listbox id; options are `${id}-${index}`. */
  id: string;
  commands: SlashCommand[];
  active: number;
  onActiveChange: (index: number) => void;
  onChoose: (command: SlashCommand) => void;
  className?: string;
}) {
  return (
    <ul
      id={id}
      role="listbox"
      aria-label="斜杠命令"
      className={cn(
        "mb-2 space-y-0.5 font-mono text-[13px] leading-[1.6]",
        className,
      )}
    >
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
            className="cursor-pointer truncate px-1 py-0.5"
            style={{ color: activeRow ? ACTIVE : INACTIVE }}
          >
            <span className="inline-block" style={{ width: `${NAME_COLS}ch` }}>
              {c.name}
            </span>
            {c.description}
          </li>
        );
      })}
    </ul>
  );
}
