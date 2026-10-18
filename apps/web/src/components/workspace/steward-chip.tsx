import type { ConversationInfo, ProjectView } from "@eta/client-contracts";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { CheckIcon } from "@phosphor-icons/react/Check";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { agentName, useAgentList } from "@/queries/agents";
import { useConversationActions } from "@/queries/conversations";
import { useSetProjectSteward } from "@/queries/projects";
import { AgentAvatar } from "./agent-identity";

const onError = (error: Error) => toast.error(error.message);

/**
 * Who takes what nobody is named for, in the header.
 *
 * The effective steward is the conversation's own pick, else its project's, so the menu has both
 * levels: this conversation (an agent, or "follow the project") and the project itself. The old
 * steward keeps its session and stays a member; the timeline gets a line saying so.
 */
export function StewardChip({
  info,
  project,
  className,
}: {
  info: ConversationInfo | undefined;
  project: ProjectView | undefined;
  className?: string;
}) {
  const { t: translateText } = useTranslation(["chat", "common"] as const);
  const { agents } = useAgentList();
  const { setSteward } = useConversationActions();
  const projectSteward = useSetProjectSteward();
  if (info === undefined || info.kind === "direct") return null;
  const pickFor = (agentId: string | null) =>
    setSteward.mutate({ conversationId: info.id, agentId }, { onError });
  const pickForProject = (agentId: string | null) =>
    project &&
    projectSteward.mutate({ projectId: project.id, agentId }, { onError });
  const name =
    info.stewardId === null
      ? translateText("chat:steward.none")
      : agentName(agents, info.stewardId);
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
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          {translateText("chat:steward.thisConversation")}
        </DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => pickFor(null)}>
          <span className="min-w-0 flex-1 truncate">
            {translateText("chat:steward.followProject")}
          </span>
          {info.stewardOverrideId === null ? (
            <CheckIcon aria-label={translateText("common:labels.current")} />
          ) : null}
        </DropdownMenuItem>
        {agents.map((agent) => (
          <DropdownMenuItem key={agent.id} onSelect={() => pickFor(agent.id)}>
            <AgentAvatar agent={agent} className="size-4" />
            <span className="min-w-0 flex-1 truncate">{agent.name}</span>
            {info.stewardOverrideId === agent.id ? (
              <CheckIcon aria-label={translateText("common:labels.current")} />
            ) : null}
          </DropdownMenuItem>
        ))}
        {project === undefined ? null : (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                {translateText("chat:steward.project", { name: project.name })}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="min-w-40">
                <DropdownMenuItem onSelect={() => pickForProject(null)}>
                  <span className="min-w-0 flex-1 truncate">
                    {translateText("chat:steward.none")}
                  </span>
                  {project.stewardId === null ? (
                    <CheckIcon
                      aria-label={translateText("common:labels.current")}
                    />
                  ) : null}
                </DropdownMenuItem>
                {agents.map((agent) => (
                  <DropdownMenuItem
                    key={agent.id}
                    onSelect={() => pickForProject(agent.id)}
                  >
                    <AgentAvatar agent={agent} className="size-4" />
                    <span className="min-w-0 flex-1 truncate">
                      {agent.name}
                    </span>
                    {project.stewardId === agent.id ? (
                      <CheckIcon
                        aria-label={translateText("common:labels.current")}
                      />
                    ) : null}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
