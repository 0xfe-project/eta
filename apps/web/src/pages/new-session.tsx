import type { ProjectChoice } from "@/components/workspace/use-project-choice";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { AgentAvatar } from "@/components/workspace/agent-identity";
import { ProjectField } from "@/components/workspace/project-field";
import { useAgents } from "@/components/workspace/use-agents";
import {
  useChosenProject,
  useResolveProject,
} from "@/components/workspace/use-project-choice";
import { useConversationActions } from "@/queries/conversations";

/**
 * Starting a conversation: a project and an agent.
 *
 * The project is one of the existing ones, or a path to add (adding a path that is already a
 * project returns that project, so the form never asks twice). A project made here takes the agent
 * as its steward, because a conversation with nobody to take its first message is a room nobody
 * answers in. The result shows up in the sidebar under its project like any other.
 *
 * Nothing is asked that has a reasonable default: the project is the one the sidebar's "+" was
 * pressed on, else the first, and the agent list is the same one the sidebar shows.
 */
export function NewSessionPage() {
  const { t: translateText } = useTranslation([
    "chat",
    "agents",
    "common",
  ] as const);
  const navigate = useNavigate();
  const { agents, loaded } = useAgents();
  const { create } = useConversationActions();
  const resolver = useResolveProject();
  // The sidebar's per-project "+" hands the project over in the URL.
  const search = useSearch({ strict: false }) as { project?: string };
  const [agentId, setAgentId] = useState<string | undefined>(undefined);
  const [choice, setChoice] = useState<ProjectChoice>({
    projectId: search.project,
    path: "",
  });
  const { project, adding } = useChosenProject(choice);
  const [failed, setFailed] = useState("");
  const chosen = agentId ?? agents[0]?.id;

  const start = async () => {
    if (chosen === undefined) return;
    setFailed("");
    try {
      const target = await resolver.resolve(choice, project, chosen);
      const { conversation } = await create.mutateAsync({
        projectId: target.id,
        agentIds: [chosen],
      });
      void navigate({
        to: "/",
        search: { group: conversation.id, view: "context" },
      });
    } catch (error) {
      setFailed((error as Error).message);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-xl min-h-0 flex-col gap-4 p-4">
      <h1 className="text-lg font-semibold">
        {translateText("chat:new.title")}
      </h1>
      <p className="text-xs text-muted-foreground">
        {translateText("chat:new.hint")}
      </p>
      <ProjectField choice={choice} onChange={setChoice} />
      <fieldset className="grid gap-1">
        <legend className="mb-1 text-sm">
          {translateText("chat:new.agent")}
        </legend>
        {!loaded ? (
          <p className="text-xs text-muted-foreground">…</p>
        ) : (
          <ul className="max-h-72 overflow-y-auto border border-border">
            {agents.map((agent) => (
              <li key={agent.id}>
                <button
                  type="button"
                  aria-pressed={chosen === agent.id}
                  onClick={() => setAgentId(agent.id)}
                  className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm hover:bg-muted aria-pressed:bg-muted"
                >
                  <AgentAvatar agent={{ id: agent.id }} className="size-4" />
                  <span className="min-w-0 flex-1 truncate">{agent.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </fieldset>
      {failed.length > 0 ? (
        <p role="alert" className="text-xs text-state-error">
          {failed}
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        <Button
          onClick={() => void start()}
          disabled={
            create.isPending ||
            resolver.pending ||
            agents.length === 0 ||
            (adding && choice.path.trim().length === 0)
          }
        >
          {translateText("chat:new.start")}
        </Button>
        <Button
          variant="ghost"
          onClick={() => void navigate({ to: "/", search: {} })}
        >
          {translateText("common:actions.cancel")}
        </Button>
      </div>
    </div>
  );
}
