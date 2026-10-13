import type { AssigneeOption, TaskDetail } from "@/queries/tasks";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { usePullRequest } from "@/queries/forge";
import { useAssistTask, useTasks } from "@/queries/tasks";
import { Select, SelectOption } from "./select-field";
import {
  isPullURL,
  providerLabel,
  remoteLabel,
  runtimeLabel,
} from "./task-format";
import { useWorkspaceStore } from "./workspace-store";

// 请 Agent 协助: another agent on the task's computer does one piece of work
// on it (a review, a test run) beside its assignee, in a place of its own.
// Who it is reads as its name only; what it is for is in the request.

/** What the request can start from; none is required. */
const purposes = [
  {
    label: "代码审查",
    text: "审查交付的改动：正确性、边界情况、和任务要求是否一致。列出问题（附文件和行号）和建议，只读，不要改代码。",
  },
  {
    label: "测试验证",
    text: "检出交付的改动，运行相关测试并实际验证行为，报告结果和复现步骤。不要提交改动。",
  },
  {
    label: "问题分析",
    text: "分析下面这个问题，找出原因并给出修复建议：\n\n",
  },
  { label: "其他", text: "" },
];

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

/** The task's latest delivered pull request, if any. */
function latestPull(task: TaskDetail) {
  for (const a of [...task.activity].reverse()) {
    const url = a.data.url;
    if (a.kind === "deliverable" && typeof url === "string" && isPullURL(url))
      return {
        url,
        title:
          (typeof a.data.title === "string" && a.data.title) ||
          url.replace("https://github.com/", ""),
      };
  }
  return null;
}

/** Why the task cannot be assisted now, and how to make it so. */
function blocker(task: TaskDetail, agents: AssigneeOption[] | undefined) {
  if (task.assignee.kind !== "remote")
    return "这个任务还没有指派到远程电脑。协助的 Agent 和主执行者在同一台电脑上工作：先在「指派给」里选一台电脑。";
  if (task.status === "done" || task.status === "cancelled")
    return "任务已经结束，它的工作位置已收尾。把状态改回进行中后再请 Agent 协助。";
  if (agents && !agents.length)
    return `${task.assignee.computer_name ?? "这台电脑"} 上没有可用的 Agent。在 设置 → 远程电脑 里看它的运行时是否在线、已配对；装了新的 Agent 后点「更新」重新上报。`;
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
  const { data } = useTasks();
  const agents = data ? agentsFor(task, data.assignees) : undefined;
  const why = blocker(task, agents);
  const setSettings = useWorkspaceStore((s) => s.setSettings);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>请 Agent 协助</DialogTitle>
          <DialogDescription>
            请这台电脑上的另一个 Agent 做一件事，例如审查交付的 PR。它在单独的
            worktree 里工作，结果回复在这个任务下；主执行者和任务状态不变。
          </DialogDescription>
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
                  打开远程电脑设置
                </Button>
              ) : null}
              <Button onClick={() => onOpenChange(false)}>知道了</Button>
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
            正在读取这台电脑上的 Agent…
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

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
  const assist = useAssistTask();
  const [chosen, setChosen] = useState(() =>
    agentKey(
      (initial && agents.find((a) => agentKey(a) === agentKey(initial))) ??
        agents[0],
    ),
  );
  const [request, setRequest] = useState("");
  const pull = latestPull(task);
  const [withPull, setWithPull] = useState(Boolean(pull));
  // One request, however often it is sent: a retry is the same assist.
  const [key] = useState(() => crypto.randomUUID());
  const agent = agents.find((a) => agentKey(a) === chosen);
  const { head, reading } = usePullHead(
    task.id,
    withPull ? pull?.url : undefined,
  );
  const ready = Boolean(agent && request.trim()) && !reading;
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
          pull:
            withPull && pull ? { url: pull.url, head_sha: head } : undefined,
        },
      },
      {
        onSuccess: () => {
          toast(`已请 ${providerLabel(agent.provider)} 协助`);
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
          Agent
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
                ? "（主执行者，另开会话）"
                : ""}
              {a.online ? "" : "（离线）"}
            </SelectOption>
          ))}
        </Select>
        {agent && !agent.online ? (
          <p className="text-xs text-muted-foreground">
            {runtimeLabel(agent.runtime)} 现在离线：请求会排队，电脑连上后开始。
          </p>
        ) : null}
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="assist-request" className="text-xs">
          协助要求
        </Label>
        <div
          className="flex flex-wrap gap-1"
          role="group"
          aria-label="从常用要求开始"
        >
          {purposes.map((p) => (
            <Button
              key={p.label}
              type="button"
              size="xs"
              variant="outline"
              onClick={() => {
                // Only an empty request, or one still a starting text, is replaced.
                if (!request.trim() || purposes.some((q) => q.text === request))
                  setRequest(p.text);
                document.getElementById("assist-request")?.focus();
              }}
            >
              {p.label}
            </Button>
          ))}
        </div>
        <Textarea
          id="assist-request"
          rows={4}
          maxLength={20000}
          placeholder="要它做什么，例如：审查 PR，重点看边界情况和测试覆盖"
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
      {pull ? (
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={withPull}
            onChange={(e) => setWithPull(e.target.checked)}
          />
          <span className="min-w-0">
            <span className="wrap-anywhere">附上交付的 PR：{pull.title}</span>
            <span className="block text-xs text-muted-foreground">
              {!withPull
                ? "不指定 PR，Agent 按要求自己看。"
                : reading
                  ? "正在读取 PR 当前的 head…"
                  : headNote(head)}
            </span>
          </span>
        </label>
      ) : null}
      <DialogFooter>
        <Button type="submit" disabled={!ready || assist.isPending}>
          {assist.isPending ? "正在发送…" : "请 Agent 协助"}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** The pull request's head commit now, as GitHub has it; empty if unknown. */
function usePullHead(task: string, url: string | undefined) {
  const pull = usePullRequest(task, url ?? "");
  return {
    head: url && pull.data ? pull.data.head_sha : "",
    reading: Boolean(url) && pull.isPending,
  };
}

function headNote(head: string) {
  return head
    ? `固定在当前 head ${head.slice(0, 7)}：Agent 检出这个提交来看，不看本地分支。`
    : "读不到 PR 当前的 head：Agent 会自己查出来，并在回复里写明看的是哪个提交。";
}
