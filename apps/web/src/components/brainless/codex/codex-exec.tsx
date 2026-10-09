import * as React from "react";
import { ToolDisclosure } from "@/components/brainless/tool-disclosure";

/**
 * CodexExec — a Codex action/exec line: a command or edit with an optional
 * result count, and expandable output as a real <details> disclosure.
 */
type Status = "ok" | "error" | "run";

const DOT: Record<Status, string> = {
  ok: "var(--terminal-success)",
  error: "var(--terminal-error)",
  run: "var(--terminal-warning)",
};

export function CodexExec({
  command,
  result,
  status = "ok",
  defaultOpen = false,
  className,
  children,
}: {
  command: string;
  result?: string;
  status?: Status;
  defaultOpen?: boolean;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <ToolDisclosure
      defaultOpen={defaultOpen}
      className={className}
      leading={<span style={{ color: DOT[status] }}>•</span>}
      heading={<span className="text-[var(--terminal-link)]">{command}</span>}
      trailing={result}
    >
      {children}
    </ToolDisclosure>
  );
}
