import type { AssigneeOption, TaskDetail } from "@/queries/tasks";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { translate } from "@/lib/i18n";
import { useAssistTask, useTasks } from "@/queries/tasks";
import { Select, SelectOption } from "./select-field";
import {
  isActive,
  isPullURL,
  providerLabel,
  remoteLabel,
  runtimeLabel,
} from "./task-format";
import { useWorkspaceStore } from "./workspace-store";

// 请 Agent 协助: another agent on the task's computer does one piece of work
// on it (a review, a test run) beside its assignee, in a place of its own.
// Who it is reads as its name only; what it is to do is the user's own words.

/** "runtime:provider", an agent on the task's computer. */
const agentKey = (a: { runtime: string; provider: string }) =>
  `${a.runtime}:${a.provider}`;

/**
 * The agents on the task's computer, one per runtime and provider, in the
 * order to offer them: online ones, then others than the assignee, then
 * those in the assignee's runtime.
 */
function agentsFor(task: TaskDetail, assignees: AssigneeOption[]) {
  const seen = new Set<string>();
  const main = agentKey({
    runtime: task.assignee.runtime ?? "",
    provider: task.assignee.provider ?? "",
  });
  const rank = (a: AssigneeOption) =>
    (a.online ? 0 : 4) +
    (agentKey(a) === main ? 2 : 0) +
    (a.runtime === task.assignee.runtime ? 0 : 1);
  return assignees
    .filter((a) => a.computer_id === task.assignee.computer_id)
    .filter((a) => !seen.has(agentKey(a)) && seen.add(agentKey(a)))
    .sort((a, b) => rank(a) - rank(b));
}

/** Whether the task has delivered a pull request. */
const hasPull = (task: TaskDetail) =>
  task.activity.some(
    (a) =>
      a.kind === "deliverable" &&
      typeof a.data.url === "string" &&
      isPullURL(a.data.url),
  );

/** Why the task cannot be assisted now, and how to make it so. */
function blocker(task: TaskDetail, agents: AssigneeOption[] | undefined) {
  if (task.assignee.kind !== "remote")
    return translate("tasks:assist.errors.noRemoteAssignee");
  if (task.status === "done" || task.status === "cancelled")
    return translate("tasks:assist.errors.taskEnded");
  if (agents && !agents.length)
    return translate("tasks:assist.errors.noAvailableAgents", {
      computerName:
        task.assignee.computer_name ??
        translate("computers:labels.thisComputer"),
    });
  return null;
}

export function AssistDialog({
  task,
  open,
  onOpenChange,
  agent,
}: {
  task: TaskDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Preselected, to ask an agent about its answer. */
  agent?: { runtime: string; provider: string };
}) {
  const { t: translateText } = useTranslation([
    "tasks",
    "common",
    "computers",
  ] as const);
  const { data } = useTasks();
  const agents = data ? agentsFor(task, data.assignees) : undefined;
  const why = blocker(task, agents);
  const setSettings = useWorkspaceStore((s) => s.setSettings);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{translateText("assist.title")}</DialogTitle>
        </DialogHeader>
        {why ? (
          <>
            <p role="status" className="text-sm">
              {why}
            </p>
            <DialogFooter>
              {task.assignee.kind === "remote" && agents && !agents.length ? (
                <Button
                  variant="outline"
                  onClick={() => {
                    onOpenChange(false);
                    setSettings({ open: true, section: "computers" });
                  }}
                >
                  {translateText("computers:actions.openSettings")}
                </Button>
              ) : null}
              <Button onClick={() => onOpenChange(false)}>
                {translateText("common:actions.gotIt")}
              </Button>
            </DialogFooter>
          </>
        ) : agents ? (
          <AssistForm
            key={open ? "open" : "closed"}
            task={task}
            agents={agents}
            initial={agent}
            onDone={() => onOpenChange(false)}
          />
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            {translateText("assist.loadingAgents")}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The assignee's latest run, which a request can wait for. */
const mainRun = (task: TaskDetail) => task.runs.filter((r) => !r.assist).at(-1);

function AssistForm({
  task,
  agents,
  initial,
  onDone,
}: {
  task: TaskDetail;
  agents: AssigneeOption[];
  initial?: { runtime: string; provider: string };
  onDone: () => void;
}) {
  const { t: translateText } = useTranslation([
    "tasks",
    "common",
    "computers",
  ] as const);
  const assist = useAssistTask();
  const [chosen, setChosen] = useState(() =>
    agentKey(
      (initial && agents.find((a) => agentKey(a) === agentKey(initial))) ??
        agents[0],
    ),
  );
  const [request, setRequest] = useState("");
  const run = mainRun(task);
  // While the assignee works, what it delivers is what to look at.
  const [after, setAfter] = useState(() =>
    Boolean(run && isActive(run.status)),
  );
  const [loop, setLoop] = useState(false);
  const [rounds, setRounds] = useState("3");
  // One request, however often it is sent: a retry is the same assist.
  const [key] = useState(() => crypto.randomUUID());
  const agent = agents.find((a) => agentKey(a) === chosen);
  // A review loop reviews the pull request: there is one, or will be.
  const canLoop = hasPull(task) || after;
  const ready = Boolean(agent && request.trim());
  const submit = () => {
    const body = request.trim();
    if (!agent || !ready || assist.isPending) return;
    assist.mutate(
      {
        id: task.id,
        key,
        input: {
          runtime: agent.runtime as "paseo" | "herdr",
          provider: agent.provider,
          request: body,
          after_run: after && run ? run.id : undefined,
          loop: canLoop && loop ? { max_rounds: Number(rounds) } : undefined,
          key,
        },
      },
      {
        onSuccess: () => {
          toast(
            translateText("assist.requested", {
              name: providerLabel(agent.provider),
            }),
          );
          onDone();
        },
        onError: (error) => toast.error(error.message),
      },
    );
  };
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="grid gap-1.5">
        <Label htmlFor="assist-agent" className="text-xs">
          {translateText("common:entities.agents")}
        </Label>
        <Select
          id="assist-agent"
          className="w-full"
          value={chosen}
          onValueChange={setChosen}
        >
          {agents.map((a) => (
            <SelectOption key={agentKey(a)} value={agentKey(a)}>
              {remoteLabel(a)}
              {a.runtime === task.assignee.runtime &&
              a.provider === task.assignee.provider
                ? translateText("assist.primaryAgentSuffix")
                : ""}
              {a.online ? "" : translateText("common:status.offlineSuffix")}
            </SelectOption>
          ))}
        </Select>
        {agent && !agent.online ? (
          <p className="text-xs text-muted-foreground">
            {translateText("assist.offlineWarning", {
              computerName: runtimeLabel(agent.runtime),
            })}
          </p>
        ) : null}
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="assist-request" className="text-xs">
          {translateText("assist.fields.briefLabel")}
        </Label>
        <Textarea
          id="assist-request"
          rows={4}
          maxLength={20000}
          placeholder={translateText("assist.fields.briefPlaceholder")}
          value={request}
          onChange={(e) => setRequest(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
        />
      </div>
      <fieldset className="grid gap-1.5">
        <legend className="mb-1.5 text-xs font-medium">
          {translateText("assist.fields.startLabel")}
        </legend>
        <div
          role="radiogroup"
          aria-label={translateText("assist.fields.startLabel")}
          className="flex gap-1"
        >
          <Button
            type="button"
            role="radio"
            aria-checked={!after}
            size="sm"
            variant={after ? "outline" : "default"}
            onClick={() => setAfter(false)}
          >
            {translateText("assist.start.now")}
          </Button>
          <Button
            type="button"
            role="radio"
            aria-checked={after}
            size="sm"
            variant={after ? "default" : "outline"}
            disabled={!run}
            onClick={() => setAfter(true)}
          >
            {translateText("assist.start.afterDelivery")}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {after
            ? translateText("assist.start.afterDeliveryHelp")
            : translateText("assist.start.nowHelp")}
        </p>
      </fieldset>
      {canLoop ? (
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={loop}
            onChange={(e) => setLoop(e.target.checked)}
          />
          <span className="min-w-0">
            {translateText("assist.review.requestChangesLoop")}
            <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <span className="whitespace-nowrap">
                {translateText("assist.review.upTo")}
              </span>
              <Select
                aria-label={translateText("assist.review.maxRoundsLabel")}
                size="sm"
                className="w-16"
                value={rounds}
                disabled={!loop}
                onValueChange={setRounds}
              >
                {Array.from({ length: 10 }, (_, i) => String(i + 1)).map(
                  (n) => (
                    <SelectOption key={n} value={n}>
                      {n}
                    </SelectOption>
                  ),
                )}
              </Select>
              <span className="whitespace-nowrap">
                {translateText("assist.review.roundsSuffix")}
              </span>
              <span className="basis-full">
                {translateText("assist.review.help")}
              </span>
            </span>
          </span>
        </label>
      ) : null}
      <DialogFooter>
        <Button type="submit" disabled={!ready || assist.isPending}>
          {assist.isPending
            ? translateText("assist.sending")
            : translateText("assist.title")}
        </Button>
      </DialogFooter>
    </form>
  );
}
