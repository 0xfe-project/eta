import type {
  AgentRuntime,
  AgentView,
  ProjectView,
} from "@eta/client-contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Empty, Loading } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { folderName, projectPlace } from "@/lib/projects";
import { useConversationActions } from "@/queries/conversations";
import { useCreateProject, useMachines } from "@/queries/projects";
import { wireErrorMessage } from "@/queries/wire";
import { AgentAvatar } from "./agent-identity";
import { DirectoryPicker, Tag } from "./directory-picker";
import { useReturnFocus } from "./return-focus";
import { Stepper } from "./stepper";
import { useAgents } from "./use-agents";
import { moveRow, useDirectoryBrowser } from "./use-directory-browser";
import { rememberDirectory, useChoosable } from "./use-project-choice";
import { useWorkspaceStore } from "./workspace-store";

/** Where the conversation will work; without `project`, a directory that starting will add. */
interface Target {
  machineId: string;
  path: string;
  project?: ProjectView | undefined;
}

/** Who is in it. The steward is always one of the members; nobody chosen has no steward. */
interface Selection {
  members: string[];
  stewardId: string | undefined;
}

/** With more agents than this, the list gets a search. */
const SEARCH_FROM = 8;

const RUNTIME_NAMES: Record<Exclude<AgentRuntime, "eta">, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  pi: "Pi",
};

/**
 * Starting a conversation, in two steps: where, then who.
 *
 * A dialog over whatever is on screen, like settings — not a page. Going to a page for it took the
 * sidebar and the panel away, which left a mostly empty screen behind a form that fits in a corner
 * of it. The window keeps its size across the steps, so nothing moves under the pointer.
 *
 * Nothing is written until 开始: a directory becomes a project then, with the steward on it, so a
 * dialog closed halfway leaves nothing behind. Opened from a project the first step is already
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
  const browser = useDirectoryBrowser({
    machineId: within?.machineId,
    path: within?.path,
  });
  const [target, setTarget] = useState<Target | undefined>(
    within && {
      machineId: within.machineId,
      path: within.path,
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

  const fallback = (
    agents.find((agent) => agent.id === target?.project?.stewardId) ?? agents[0]
  )?.id;
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
        stewardId: stewardId === agentId ? rest[0] : stewardId,
      });
    } else {
      setPicked({
        members: [...members, agentId],
        stewardId: stewardId ?? agentId,
      });
    }
  };

  const choose = (next: Target) => {
    browser.closeTyping();
    setTarget(next);
    // An empty list has nothing to keep: the new target's defaults are better than none.
    setPicked((now) => (now?.members.length ? now : undefined));
    setFailed("");
    setStep(1);
  };

  const start = async (where: Target, who: Selection) => {
    if (sendingRef.current || who.stewardId === undefined) return;
    sendingRef.current = true;
    setFailed("");
    try {
      const project =
        where.project ??
        (
          await createProject.mutateAsync({
            path: where.path,
            machineId: where.machineId,
            stewardId: who.stewardId,
          })
        ).project;
      const { conversation } = await create.mutateAsync({
        projectId: project.id,
        agentIds: who.members,
        stewardId: who.stewardId,
      });
      rememberDirectory(where.machineId, where.path);
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

  const next = () => {
    const { listed, machineId } = browser;
    if (listed === undefined) return;
    const where = {
      machineId,
      path: listed.path,
      project: projects.find(
        (project) =>
          project.machineId === machineId && project.path === listed.path,
      ),
    };
    choose(where);
    if (only !== undefined)
      void start(where, { members: [only.id], stewardId: only.id });
  };

  return (
    <DialogContent
      aria-describedby={undefined}
      onCloseAutoFocus={onCloseAutoFocus}
      className="flex h-[min(560px,calc(100dvh-2rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-[560px]"
      onEscapeKeyDown={(event) => {
        if (event.isComposing) event.preventDefault();
        else if (browser.typing !== undefined) {
          event.preventDefault();
          browser.closeTyping();
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
        <DirectoryPicker
          browser={browser}
          onProject={(project) =>
            choose({
              machineId: project.machineId,
              path: project.path,
              project,
            })
          }
        />
      ) : (
        <MembersStep
          target={target}
          agents={agents}
          loaded={loaded}
          selection={selection}
          failed={failed}
          onToggle={toggle}
          onLead={(stewardId) => setPicked({ ...selection, stewardId })}
        />
      )}
      <DialogFooter className="shrink-0 flex-row justify-between border-t p-3">
        <Button variant="ghost" disabled={pending} onClick={onDone}>
          {translateText("common:actions.cancel")}
        </Button>
        {step === 0 ? (
          <Button
            disabled={
              browser.listed === undefined ||
              browser.typing !== undefined ||
              pending
            }
            onClick={next}
          >
            {translateText(
              only === undefined ? "common:actions.next" : "chat:new.start",
            )}
          </Button>
        ) : (
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => setStep(0)}
            >
              {translateText("common:actions.previous")}
            </Button>
            <Button
              disabled={selection.stewardId === undefined || pending}
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

/** One list: a tick makes a member, and a member can be made the steward from its own row. */
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
      {agents.length > SEARCH_FROM ? (
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
                <li
                  key={agent.id}
                  data-member={member}
                  className="flex min-h-9 items-center hover:bg-muted data-[member=true]:bg-muted pointer-coarse:min-h-11"
                >
                  <label className="flex min-h-9 min-w-0 flex-1 cursor-pointer items-center gap-2 px-2 text-sm pointer-coarse:min-h-11">
                    <Checkbox
                      checked={member}
                      onCheckedChange={() => onToggle(agent.id)}
                    />
                    <AgentAvatar
                      agent={{ id: agent.id }}
                      className="size-4 shrink-0"
                    />
                    <span className="truncate">{agent.name}</span>
                    <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                      {agent.runtime === "eta"
                        ? translateText("agents:runtime.eta")
                        : RUNTIME_NAMES[agent.runtime]}
                    </span>
                    {away === undefined ? null : <Tag warn>{away}</Tag>}
                  </label>
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
                </li>
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
