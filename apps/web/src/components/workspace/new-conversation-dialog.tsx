import type { AgentView, ProjectView } from "@eta/client-contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Empty, Loading } from "@/components/states";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { folderName, projectPlace } from "@/lib/projects";
import { useConversationActions } from "@/queries/conversations";
import { placesCall } from "@/queries/places";
import { useCreateProject, useMachines } from "@/queries/projects";
import { wireErrorMessage } from "@/queries/wire";
import { AGENT_SEARCH_FROM } from "./agent-pick";
import { AgentPickRow } from "./agent-pick-row";
import { useImportRecentDirectories } from "./import-recent";
import { moveRow } from "./move-row";
import { PlacePicker, Tag } from "./place-picker";
import { useReturnFocus } from "./return-focus";
import { Stepper } from "./stepper";
import { useAgents } from "./use-agents";
import { usePlaceFlow } from "./use-place-flow";
import { useChoosable } from "./use-project-choice";
import { useWorkspaceStore } from "./workspace-store";

/** Where the conversation will work; without `project`, a directory that starting will add. */
interface Target {
  machineId: string;
  path: string;
  /** The path as its machine writes it (`~/Developer/eta`). */
  display: string;
  project?: ProjectView | undefined;
}

/**
 * Who is in it, and which of them is the steward: one of the members, or null when the user said
 * the group has none. Undefined only while nobody is chosen.
 */
interface Selection {
  members: string[];
  stewardId: string | null | undefined;
}

/**
 * Starting a conversation, in two steps: where, then who.
 *
 * A dialog over whatever is on screen, like settings — not a page. Going to a page for it took the
 * sidebar and the panel away, which left a mostly empty screen behind a form that fits in a corner
 * of it. The window keeps its size across the steps, so nothing moves under the pointer.
 *
 * Nothing is written until Start: a directory becomes a project then, so a dialog closed halfway
 * leaves nothing behind. The steward is the group's own, chosen here among the members (the first
 * one ticked unless another is made steward), or none. Opened from a project the first step is already
 * answered, and is still one step back.
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
  const returnFocus = useReturnFocus(open);
  // Mounted wherever the dialog can open, so the browser's old recent directories reach the host.
  useImportRecentDirectories();
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : close())}>
      {/* Mounted per open: a form left half filled in is not what the next open should show. */}
      {open ? (
        <NewConversationForm
          projectId={projectId}
          onDone={close}
          onCloseAutoFocus={returnFocus}
        />
      ) : null}
    </Dialog>
  );
}

function NewConversationForm({
  projectId,
  onDone,
  onCloseAutoFocus,
}: {
  projectId: string | undefined;
  onDone: () => void;
  onCloseAutoFocus: (event: Event) => void;
}) {
  const { t: translateText } = useTranslation(["chat", "common"] as const);
  const navigate = useNavigate();
  const { agents, loaded } = useAgents();
  const { create } = useConversationActions();
  const createProject = useCreateProject();
  const projects = useChoosable();
  // Read once: the project it was opened from, if that is one a conversation can start in.
  const [within] = useState(() =>
    projects.find((project) => project.id === projectId),
  );
  const [target, setTarget] = useState<Target | undefined>(
    within && {
      machineId: within.machineId,
      path: within.path,
      display: within.display,
      project: within,
    },
  );
  const [step, setStep] = useState(within === undefined ? 0 : 1);
  // What the user made of the list; until they touch it, the defaults for the target stand.
  const [picked, setPicked] = useState<Selection | undefined>(undefined);
  const [failed, setFailed] = useState("");
  // isPending only updates on the next render; a double click must not start two conversations.
  const sendingRef = useRef(false);
  const pending = create.isPending || createProject.isPending;

  const fallback = agents[0]?.id;
  const selection: Selection = picked ?? {
    members: fallback === undefined ? [] : [fallback],
    stewardId: fallback,
  };

  const toggle = (agentId: string) => {
    const { members, stewardId } = selection;
    if (members.includes(agentId)) {
      const rest = members.filter((id) => id !== agentId);
      setPicked({
        members: rest,
        // The steward going takes the next member; "none" stays none while anyone is left.
        stewardId:
          rest.length === 0
            ? undefined
            : stewardId === agentId
              ? rest[0]
              : stewardId,
      });
    } else {
      setPicked({
        members: [...members, agentId],
        // The first one ticked leads, unless the user already chose (someone, or nobody).
        stewardId: stewardId === undefined ? agentId : stewardId,
      });
    }
  };

  /** Pressing the steward's own button again leaves the group with none. */
  const lead = (agentId: string) =>
    setPicked({
      ...selection,
      stewardId: selection.stewardId === agentId ? null : agentId,
    });

  const choose = (next: Target) => {
    setTarget(next);
    // An empty list has nothing to keep: the new target's defaults are better than none.
    setPicked((now) => (now?.members.length ? now : undefined));
    setFailed("");
    setStep(1);
  };

  const start = async (where: Target, who: Selection) => {
    if (sendingRef.current || who.members.length === 0) return;
    sendingRef.current = true;
    setFailed("");
    try {
      const project =
        where.project ??
        (
          await createProject.mutateAsync({
            path: where.path,
            machineId: where.machineId,
          })
        ).project;
      const { conversation } = await create.mutateAsync({
        projectId: project.id,
        agentIds: who.members,
        stewardId: who.stewardId,
      });
      // Used now: first among the recent places, for every client.
      void placesCall("remember", {
        machineId: where.machineId,
        path: project.path,
      }).catch(() => undefined);
      onDone();
      useWorkspaceStore.getState().setMobilePanel("chat");
      // The conversation you just made, on itself — same rule as opening a row: no `view`, so the
      // phone lands in the chat it asked for instead of on the panel over it.
      void navigate({ to: "/", search: { group: conversation.id } });
    } catch (error) {
      setFailed(wireErrorMessage(error as Error));
    } finally {
      sendingRef.current = false;
    }
  };

  const only = agents.length === 1 ? agents[0] : undefined;

  // Where the flow ends: the directory, and the project it already is when it is one.
  const flow = usePlaceFlow({
    machineId: within?.machineId,
    onChoose: (choice) => {
      const where: Target = {
        ...choice,
        project: projects.find(
          (project) =>
            project.machineId === choice.machineId &&
            project.path === choice.path,
        ),
      };
      choose(where);
      if (only !== undefined)
        void start(where, { members: [only.id], stewardId: only.id });
    },
  });

  return (
    <DialogContent
      aria-describedby={undefined}
      onCloseAutoFocus={onCloseAutoFocus}
      className="flex h-[min(560px,calc(100dvh-2rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-[560px]"
      onEscapeKeyDown={(event) => {
        if (event.isComposing) event.preventDefault();
        else if (step === 0 && flow.key("Escape")) {
          // One page of the flow back; on its first page Escape closes.
          event.preventDefault();
        } else if (step === 1) {
          event.preventDefault();
          if (!pending) setStep(0);
        }
      }}
      onInteractOutside={(event) => {
        if (step === 1) event.preventDefault();
      }}
    >
      <DialogTitle className="sr-only">
        {translateText("chat:new.title")}
      </DialogTitle>
      <div className="shrink-0 border-b py-3 pr-11 pl-4">
        <Stepper
          steps={[
            translateText("chat:new.steps.directory"),
            translateText("chat:new.steps.members"),
          ]}
          step={step}
          label={translateText("chat:new.steps.label")}
        />
      </div>
      {step === 0 || target === undefined ? (
        <PlacePicker flow={flow} />
      ) : (
        <MembersStep
          target={target}
          agents={agents}
          loaded={loaded}
          selection={selection}
          failed={failed}
          onToggle={toggle}
          onLead={lead}
        />
      )}
      <DialogFooter className="shrink-0 flex-row justify-between border-t p-3">
        <Button variant="ghost" disabled={pending} onClick={onDone}>
          {translateText("common:actions.cancel")}
        </Button>
        {step === 0 ? null : (
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => setStep(0)}
            >
              {translateText("common:actions.previous")}
            </Button>
            <Button
              disabled={selection.members.length === 0 || pending}
              onClick={() => {
                if (target !== undefined) void start(target, selection);
              }}
            >
              {translateText("chat:new.start")}
            </Button>
          </div>
        )}
      </DialogFooter>
    </DialogContent>
  );
}

/**
 * One list: a tick makes a member, and a member can be made the steward from its own row. The
 * steward's button pressed again makes the group one without a steward.
 */
function MembersStep({
  target,
  agents,
  loaded,
  selection,
  failed,
  onToggle,
  onLead,
}: {
  target: Target;
  agents: readonly AgentView[];
  loaded: boolean;
  selection: Selection;
  failed: string;
  onToggle: (agentId: string) => void;
  onLead: (agentId: string) => void;
}) {
  const { t: translateText } = useTranslation([
    "chat",
    "agents",
    "common",
  ] as const);
  const { machines } = useMachines();
  const [search, setSearch] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  // What was pressed went with the step before: the keyboard starts here.
  useEffect(() => listRef.current?.focus({ preventScroll: true }), []);

  const needle = search.trim().toLowerCase();
  const listed = agents.filter((agent) =>
    agent.name.toLowerCase().includes(needle),
  );
  const machineName = (agent: AgentView) =>
    agent.machineId === null || agent.machineId === target.machineId
      ? undefined
      : machines.find((machine) => machine.id === agent.machineId)?.name;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 px-4 py-3">
      <div className="flex min-w-0 items-baseline gap-2 text-sm">
        <span className="max-w-[60%] shrink-0 truncate font-medium">
          {target.project?.name ?? folderName(target.path)}
        </span>
        <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
          {projectPlace(target, machines, { short: true })}
        </span>
        {target.project === undefined ? (
          <Tag>{translateText("chat:new.newProject")}</Tag>
        ) : null}
      </div>
      {agents.length > AGENT_SEARCH_FROM ? (
        <Input
          aria-label={translateText("chat:new.picker.filter")}
          placeholder={translateText("chat:new.picker.filter")}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => moveRow(event, listRef.current)}
          className="h-7 shrink-0 pointer-coarse:h-9"
        />
      ) : null}
      <div
        ref={listRef}
        tabIndex={-1}
        onKeyDown={(event) => moveRow(event, listRef.current)}
        className="min-h-0 flex-1 overflow-y-auto border border-border outline-none focus-visible:ring-1 focus-visible:ring-ring/50"
      >
        {!loaded ? (
          <Loading rows={6} />
        ) : listed.length === 0 ? (
          <div className="grid h-full place-content-center">
            <Empty
              title={translateText(
                agents.length === 0
                  ? "chat:sections.noAgents"
                  : "chat:new.picker.noMatch",
              )}
            />
          </div>
        ) : (
          <ul>
            {listed.map((agent) => {
              const member = selection.members.includes(agent.id);
              const steward = selection.stewardId === agent.id;
              const away = machineName(agent);
              return (
                <AgentPickRow
                  key={agent.id}
                  agent={agent}
                  checked={member}
                  onToggle={() => onToggle(agent.id)}
                  away={away}
                >
                  {member ? (
                    <Button
                      size="xs"
                      variant={steward ? "default" : "ghost"}
                      aria-pressed={steward}
                      aria-label={translateText(
                        steward ? "chat:steward.label" : "chat:new.makeSteward",
                        { name: agent.name },
                      )}
                      className="mr-1.5 shrink-0 pointer-coarse:h-8"
                      onClick={() => onLead(agent.id)}
                    >
                      {translateText(
                        steward ? "chat:new.steward" : "chat:new.setSteward",
                      )}
                    </Button>
                  ) : null}
                </AgentPickRow>
              );
            })}
          </ul>
        )}
      </div>
      {failed.length > 0 ? (
        <p role="alert" className="text-xs text-state-error">
          {failed}
        </p>
      ) : null}
    </div>
  );
}
