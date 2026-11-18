import type { ConversationInfo } from "@eta/client-contracts";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { CheckIcon } from "@phosphor-icons/react/Check";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { agentName, useAgentList } from "@/queries/agents";
import { useConversationActions } from "@/queries/conversations";
import { AgentAvatar } from "./agent-identity";

const onError = (error: Error) => toast.error(error.message);

/**
 * Who takes what nobody is named for, in the header.
 *
 * The steward is the group's own: one of its members, or nobody. The menu is exactly that, the
 * members and "No steward"; a project has no steward to follow. The old steward keeps its session
 * and stays a member; the timeline gets a line saying so.
 */
export function StewardChip({
  info,
  members,
  className,
}: {
  info: ConversationInfo | undefined;
  /** The group's members, as agent ids. */
  members: readonly string[];
  className?: string;
}) {
  const { t: translateText } = useTranslation(["chat", "common"] as const);
  const { agents } = useAgentList();
  const { setSteward } = useConversationActions();
  if (info === undefined || info.kind === "direct") return null;
  const pick = (agentId: string | null) =>
    setSteward.mutate({ conversationId: info.id, agentId }, { onError });
  const name =
    info.stewardId === null
      ? translateText("chat:steward.none")
      : agentName(agents, info.stewardId);
  const current = (
    <CheckIcon aria-label={translateText("common:labels.current")} />
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={translateText("chat:steward.hint")}
          aria-label={translateText("chat:steward.label", { name })}
          className={cn(
            "inline-flex min-w-0 max-w-40 items-center gap-1 border border-border px-1.5 py-0.5 text-xs text-muted-foreground outline-none hover:border-border-strong hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring",
            className,
          )}
        >
          {info.stewardId === null ? null : (
            <AgentAvatar agent={{ id: info.stewardId }} className="size-3.5" />
          )}
          <span className="min-w-0 truncate">{name}</span>
          <CaretDownIcon aria-hidden="true" className="size-3 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-48">
        {members.map((agentId) => (
          <DropdownMenuItem key={agentId} onSelect={() => pick(agentId)}>
            <AgentAvatar agent={{ id: agentId }} className="size-4" />
            <span className="min-w-0 flex-1 truncate">
              {agentName(agents, agentId)}
            </span>
            {info.stewardId === agentId ? current : null}
          </DropdownMenuItem>
        ))}
        {members.length === 0 ? null : <DropdownMenuSeparator />}
        <DropdownMenuItem onSelect={() => pick(null)}>
          <span className="min-w-0 flex-1 truncate">
            {translateText("chat:steward.none")}
          </span>
          {info.stewardId === null ? current : null}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
