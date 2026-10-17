import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AgentAvatar } from "@/components/workspace/agent-identity";
import { useAgents } from "@/components/workspace/use-agents";
import { useGroupActions } from "@/queries/groups";

/**
 * Starting a conversation, without building a group first.
 *
 * "Talk to this agent about this folder" is the smallest thing a person can want, and it used to
 * take three steps: make a group, name it, invite the agent. A conversation with one member is the
 * same shape underneath (a group with one participant), so the shortcut is honest: the form makes
 * exactly that, and the result shows up in the sidebar under its folder like any other.
 *
 * Nothing is asked that has a reasonable default: the folder defaults to the one you were last in,
 * and the agent list is the same one the sidebar shows.
 */
export function NewSessionPage() {
  const { t: translateText } = useTranslation([
    "chat",
    "agents",
    "common",
  ] as const);
  const navigate = useNavigate();
  const { agents, loaded } = useAgents();
  const { direct } = useGroupActions();
  const [agentId, setAgentId] = useState<string | undefined>(undefined);
  const [cwd, setCwd] = useState("");
  const [failed, setFailed] = useState("");

  const start = () => {
    const chosen = agentId ?? agents[0]?.id;
    if (chosen === undefined) return;
    setFailed("");
    direct.mutate(
      {
        agentId: chosen,
        ...(cwd.trim().length === 0 ? {} : { cwd: cwd.trim() }),
      },
      {
        onSuccess: (group) =>
          void navigate({
            to: "/",
            search: { group: group.id, view: "members" },
          }),
        onError: (error: Error) => setFailed(error.message),
      },
    );
  };

  return (
    <div className="mx-auto flex w-full max-w-xl min-h-0 flex-col gap-4 p-4">
      <h1 className="text-lg font-semibold">
        {translateText("chat:new.title")}
      </h1>
      <p className="text-xs text-muted-foreground">
        {translateText("chat:new.hint")}
      </p>
      <label className="grid gap-1 text-sm">
        {translateText("chat:new.folder")}
        <Input
          value={cwd}
          onChange={(event) => setCwd(event.target.value)}
          placeholder={translateText("chat:groups.fields.cwdPlaceholder")}
          spellCheck={false}
          className="font-mono"
        />
        <span className="text-xs text-muted-foreground">
          {translateText("chat:new.folderHint")}
        </span>
      </label>
      <fieldset className="grid gap-1">
        <legend className="mb-1 text-sm">
          {translateText("chat:new.agent")}
        </legend>
        {!loaded ? (
          <p className="text-xs text-muted-foreground">…</p>
        ) : (
          <ul className="max-h-72 overflow-y-auto border border-border">
            {agents.map((agent: { id: string; name: string }) => (
              <li key={agent.id}>
                <button
                  type="button"
                  aria-pressed={(agentId ?? agents[0]?.id) === agent.id}
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
          onClick={start}
          disabled={direct.isPending || agents.length === 0}
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
