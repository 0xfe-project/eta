import type { ProjectChoice } from "./use-project-choice";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Loading } from "@/components/states";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useConversationActions } from "@/queries/conversations";
import { AgentAvatar } from "./agent-identity";
import { DirectoryPicker } from "./directory-picker";
import { ProjectField } from "./project-field";
import { useAgents } from "./use-agents";
import {
  useChosenProject,
  useDirectoryBrowsing,
  useResolveProject,
} from "./use-project-choice";
import { useWorkspaceStore } from "./workspace-store";

/**
 * Starting a conversation: a project and an agent.
 *
 * A dialog over whatever is on screen, like settings — not a page. It asks two things, and going
 * to a page for them took the sidebar and the panel away, which left a mostly empty screen behind
 * a form that fits in a corner of it.
 *
 * The project is one of the existing ones, or a directory to add, chosen in a view that takes the
 * form's place (adding a path that is already a project returns that project, so the form never
 * asks twice). A project made here takes the agent
 * as its steward, because a conversation with nobody to take its first message is a room nobody
 * answers in. The result shows up in the sidebar like any other.
 *
 * Nothing is asked that has a reasonable default: the project is the one it was opened from (else
 * the first), and the agent list is the same one the sidebar shows.
 */
export function NewConversationDialog() {
  const open = useWorkspaceStore((state) => state.newConversation.open);
  const projectId = useWorkspaceStore(
    (state) => state.newConversation.projectId,
  );
  const setNewConversation = useWorkspaceStore(
    (state) => state.setNewConversation,
  );
  const close = () => setNewConversation({ open: false });
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : close())}>
      {/* Mounted per open: a form left half filled in is not what the next open should show. */}
      {open ? (
        <NewConversationForm projectId={projectId} onDone={close} />
      ) : null}
    </Dialog>
  );
}

function NewConversationForm({
  projectId,
  onDone,
}: {
  projectId: string | undefined;
  onDone: () => void;
}) {
  const { t: translateText } = useTranslation(["chat", "agents"] as const);
  const navigate = useNavigate();
  const { agents, loaded } = useAgents();
  const { create } = useConversationActions();
  const resolver = useResolveProject();
  const [agentId, setAgentId] = useState<string | undefined>(undefined);
  const [choice, setChoice] = useState<ProjectChoice>({
    projectId,
    path: "",
  });
  const { project, adding } = useChosenProject(choice);
  const { browsing, picker, dialog, browse } = useDirectoryBrowsing(
    choice,
    setChoice,
  );
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
      onDone();
      useWorkspaceStore.getState().setMobilePanel("chat");
      // The conversation you just made, on itself — same rule as opening a row: no `view`, so the
      // phone lands in the chat it asked for instead of on the panel over it.
      void navigate({ to: "/", search: { group: conversation.id } });
    } catch (error) {
      setFailed((error as Error).message);
    }
  };

  return (
    <DialogContent
      {...dialog}
      className={cn("gap-3 sm:max-w-md", dialog.className)}
    >
      {browsing ? (
        <DirectoryPicker {...picker} />
      ) : (
        <>
          <DialogHeader>
            <DialogTitle>{translateText("chat:new.title")}</DialogTitle>
            <DialogDescription>
              {translateText("chat:new.hint")}
            </DialogDescription>
          </DialogHeader>
          <ProjectField
            choice={choice}
            onChange={setChoice}
            onBrowse={browse}
          />
          <fieldset className="grid gap-1">
            <legend className="mb-1 text-sm">
              {translateText("chat:new.agent")}
            </legend>
            {!loaded ? (
              <Loading rows={3} className="border border-border" />
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
                      <AgentAvatar
                        agent={{ id: agent.id }}
                        className="size-4"
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {agent.name}
                      </span>
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
          </div>
        </>
      )}
    </DialogContent>
  );
}
