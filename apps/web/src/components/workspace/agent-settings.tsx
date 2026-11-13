import type { AgentView } from "@eta/client-contracts";
import type { ModelAvailability } from "@/queries/providers";
import { DotsThreeIcon } from "@phosphor-icons/react/DotsThree";
import { PencilSimpleIcon } from "@phosphor-icons/react/PencilSimple";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { RobotIcon } from "@phosphor-icons/react/Robot";
import { TrashIcon } from "@phosphor-icons/react/Trash";
import { WarningIcon } from "@phosphor-icons/react/Warning";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Empty, LoadError, Loading } from "@/components/states";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useModelAvailability } from "@/queries/providers";
import { DeleteAgentDialog } from "./agent-editor";
import { AgentAvatar, AgentStatus } from "./agent-identity";
import { UsageLine } from "./usage-line";
import { useAgents } from "./use-agents";

function AgentRow({ agent }: { agent: AgentView }) {
  const { t: translateText } = useTranslation(["agents", "common"] as const);
  const { openEditor } = useAgents();
  const [confirming, setConfirming] = useState(false);
  const instructions = agent.instructions.trim();
  const catalog = useModelAvailability(agent);
  // An external runtime (Claude Code, Codex, ...) names its models itself, on the machine the
  // agent runs on. The catalog here only knows eta's providers, so it has no say on them: the
  // model is shown as the agent has it, and never as gone.
  const external = agent.runtime !== "eta";
  const availability: ModelAvailability = external
    ? { state: "ok", model: undefined }
    : catalog;
  const modelName = external
    ? (agent.model ?? translateText("runtime.defaultModel"))
    : availability.state === "not_set"
      ? translateText("models.noneSelected")
      : (availability.model?.name ?? agent.model);

  return (
    <li className="flex items-start gap-3 px-3 py-2.5 transition-colors hover:bg-muted/60">
      <AgentAvatar agent={agent} />
      <button
        type="button"
        onClick={() => openEditor(agent.id)}
        aria-label={translateText("common:actions.editItem", {
          name: agent.name,
        })}
        className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left outline-none focus-visible:underline"
      >
        <span className="flex max-w-full items-center gap-2">
          <span className="truncate text-sm font-medium">{agent.name}</span>
          <span className="text-xs">
            <AgentStatus status={agent.status} />
          </span>
        </span>
        {modelName ? (
          <span
            className={cn(
              "inline-flex max-w-full items-center gap-1 text-xs",
              availability.state === "ok"
                ? "text-muted-foreground"
                : availability.state === "delisted"
                  ? "text-state-warning"
                  : "text-destructive",
            )}
            title={
              availability.state === "unavailable" ||
              availability.state === "delisted"
                ? availability.message
                : undefined
            }
          >
            {availability.state !== "ok" ? (
              <WarningIcon aria-hidden="true" className="size-3.5 shrink-0" />
            ) : null}
            <span className="truncate">{modelName}</span>
            {availability.state === "unavailable" ||
            availability.state === "delisted" ? (
              <span className="sr-only">：{availability.message}</span>
            ) : null}
          </span>
        ) : null}
        <span
          className={cn(
            "line-clamp-2 text-xs text-muted-foreground",
            !instructions && "opacity-60",
          )}
        >
          {instructions || translateText("fields.instructionsNotSet")}
        </span>
        <UsageLine agentId={agent.id} />
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={translateText("common:accessibility.itemActions", {
              name: agent.name,
            })}
          >
            <DotsThreeIcon aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-36">
          <DropdownMenuItem onSelect={() => openEditor(agent.id)}>
            <PencilSimpleIcon aria-hidden="true" />
            {translateText("common:actions.edit")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => setConfirming(true)}
          >
            <TrashIcon aria-hidden="true" />
            {translateText("common:actions.delete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DeleteAgentDialog
        agent={agent}
        open={confirming}
        onOpenChange={setConfirming}
      />
    </li>
  );
}

export function AgentSettings() {
  const { t: translateText } = useTranslation(["agents", "common"] as const);
  const { agents: all, loaded, error, openEditor } = useAgents();
  // Captain is eta's own agent, with its own place at the head of the sidebar; the host refuses to
  // edit or delete it as an ordinary agent, so a row here would only offer actions that fail.
  const agents = all.filter((agent) => agent.systemRole !== "captain");

  if (error && !loaded)
    return (
      <LoadError what={translateText("common:entities.agents")} error={error} />
    );
  if (!loaded) return <Loading />;
  if (agents.length === 0)
    return (
      <Empty
        icon={RobotIcon}
        title={translateText("empty.title")}
        action={
          <Button size="sm" onClick={() => openEditor()}>
            <PlusIcon aria-hidden="true" data-icon="inline-start" />
            {translateText("actions.create")}
          </Button>
        }
      >
        {translateText("empty.description")}
      </Empty>
    );

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">
          {translateText("common:entities.agents")}
          <span className="ml-1.5 font-normal tabular-nums text-muted-foreground">
            {agents.length}
          </span>
        </h2>
        <Button size="sm" onClick={() => openEditor()}>
          <PlusIcon aria-hidden="true" data-icon="inline-start" />
          {translateText("common:actions.new")}
        </Button>
      </div>
      <ul
        aria-label={translateText("accessibility.agentList")}
        className="divide-y border"
      >
        {agents.map((agent) => (
          <AgentRow key={agent.id} agent={agent} />
        ))}
      </ul>
    </div>
  );
}
