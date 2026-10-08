"use client";

import { cn } from "@/lib/utils";

/**
 * CodexSlashMenu — Codex CLI's slash-command palette.
 *
 * Flat list under the `›` composer: padded command name + description. The
 * CodexPrompt input filters it and moves the active row.
 */
export interface CodexSlashCommand {
  name: string;
  description: string;
}

const ACTIVE = "var(--terminal-foreground)";
const INACTIVE = "var(--terminal-muted)";
const NAME_COLS = 16;

export function CodexSlashMenu({
  id,
  commands,
  active,
  onActiveChange,
  onChoose,
  className,
}: {
  /** Listbox id; options are `${id}-${index}`. */
  id: string;
  commands: CodexSlashCommand[];
  active: number;
  onActiveChange: (index: number) => void;
  onChoose: (command: CodexSlashCommand) => void;
  className?: string;
}) {
  return (
    <ul
      id={id}
      role="listbox"
      aria-label="斜杠命令"
      className={cn(
        "mt-2 space-y-0.5 pl-[2ch] font-mono text-[13px] leading-[1.6]",
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
            className="cursor-pointer truncate"
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
