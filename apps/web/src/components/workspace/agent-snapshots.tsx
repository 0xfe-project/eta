import type { AgentSnapshot } from "@/api/control-plane.gen";
import type { Agent } from "@/queries/chat";
import { useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useAgentSnapshots, useRestoreSnapshot } from "@/queries/chat";
import { when } from "./routine-format";

function label(snapshot: AgentSnapshot, all: AgentSnapshot[]) {
  switch (snapshot.kind) {
    case "turn":
      return snapshot.message ? `「${snapshot.message}」之后` : "一次回复之后";
    case "restore": {
      const from = all.find((s) => s.id === snapshot.restored_from);
      return from ? `回到了 ${when(from.saved_at)} 的状态` : "回到了更早的状态";
    }
    case "copy":
      return "复制自另一个智能体";
    default:
      return "之前保存的状态";
  }
}

/**
 * The agent's snapshots: its workspace and Codex thread after each of its
 * last turns. Going back to one undoes what came after it for the agent;
 * the conversation keeps showing it.
 */
export function AgentSnapshots({ agent }: { agent: Agent }) {
  const { data: snapshots } = useAgentSnapshots(agent.id);
  const restore = useRestoreSnapshot();
  const [target, setTarget] = useState<AgentSnapshot>();
  if (!snapshots?.length) return null;
  return (
    <section aria-label="快照" className="space-y-1.5">
      <h3 className="text-sm font-medium">快照</h3>
      <ul className="divide-y border text-xs">
        {snapshots.map((snapshot) => (
          <li key={snapshot.id} className="flex items-center gap-2 px-2 py-1.5">
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {when(snapshot.saved_at)}
            </span>
            <span className="min-w-0 flex-1 truncate">
              {label(snapshot, snapshots)}
            </span>
            {snapshot.current ? (
              <span className="shrink-0 text-muted-foreground">当前</span>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={restore.isPending}
                onClick={() => setTarget(snapshot)}
              >
                回到这里
              </Button>
            )}
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">
        每次回复后保存工作区和会话，保留最近 5 份。
      </p>
      <AlertDialog
        open={Boolean(target)}
        onOpenChange={(open) => !open && setTarget(undefined)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>回到这个快照？</AlertDialogTitle>
            <AlertDialogDescription>
              {agent.name}
              的工作区和会话会回到{target ? ` ${when(target.saved_at)} ` : ""}
              的状态，之后的改动和对话它都不再记得；对话记录仍然显示。智能体会重启，正在进行的回复需要先结束。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                target &&
                restore.mutate(
                  { agentId: agent.id, snapshotId: target.id },
                  {
                    onSuccess: () => toast.success("已回到这个快照"),
                    onError: (error) => toast.error(error.message),
                  },
                )
              }
            >
              回到这里
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
