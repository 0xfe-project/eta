import type { AgentView } from "@eta/client-contracts";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Checkbox } from "@/components/ui/checkbox";
import { AgentAvatar } from "./agent-identity";
import { runtimeName } from "./agent-pick";
import { Tag } from "./directory-picker";

/**
 * One agent in a list to pick several from: a tick, its avatar, its name and what it runs on, the
 * whole row a press. Starting a conversation and inviting into one draw the same row.
 */
export function AgentPickRow({
  agent,
  checked,
  onToggle,
  away,
  children,
}: {
  agent: Pick<AgentView, "id" | "name" | "runtime">;
  checked: boolean;
  onToggle: () => void;
  /** The machine it lives on, when that is not where the list is for. */
  away?: string | undefined;
  /** What the row offers past its tick, at its end. */
  children?: ReactNode;
}) {
  const { t: translateText } = useTranslation(["agents"] as const);
  return (
    <li
      data-member={checked}
      className="flex min-h-9 items-center hover:bg-muted data-[member=true]:bg-muted pointer-coarse:min-h-11"
    >
      <label className="flex min-h-9 min-w-0 flex-1 cursor-pointer items-center gap-2 px-2 text-sm pointer-coarse:min-h-11">
        <Checkbox checked={checked} onCheckedChange={onToggle} />
        <AgentAvatar agent={{ id: agent.id }} className="size-4 shrink-0" />
        <span className="truncate">{agent.name}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {agent.runtime === "eta"
            ? translateText("agents:runtime.eta")
            : runtimeName(agent.runtime)}
        </span>
        {away === undefined ? null : <Tag warn>{away}</Tag>}
      </label>
      {children}
    </li>
  );
}
