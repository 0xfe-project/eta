import { CheckIcon } from "@phosphor-icons/react/Check";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { TrashIcon } from "@phosphor-icons/react/Trash";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { Task } from "./types";

export function AddTask({
  onAdd,
  variant = "outline",
}: {
  onAdd: (title: string) => void;
  variant?: "outline" | "default" | "ghost";
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant={variant}>
          <PlusIcon aria-hidden="true" /> 新建任务
        </Button>
      </DialogTrigger>
      <DialogContent aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>添加任务</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (!title.trim()) return;
            onAdd(title.trim());
            setTitle("");
            setOpen(false);
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="task-title">任务</Label>
            <Input
              id="task-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={200}
              required
            />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={!title.trim()}>
              添加任务
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function TaskList({
  tasks,
  onToggle,
  onDelete,
  onAdd,
}: {
  tasks: Task[];
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
  onAdd: (title: string) => void;
}) {
  return (
    <section>
      <header className="flex items-center justify-between gap-2 py-1">
        <h2 className="text-sm font-medium">任务</h2>
        <AddTask onAdd={onAdd} variant="ghost" />
      </header>
      {tasks.length ? (
        <ul className="divide-y divide-border">
          {tasks.map((task) => (
            <li key={task.id} className="group flex items-center gap-2 py-2">
              <button
                type="button"
                role="checkbox"
                aria-checked={task.done}
                aria-label={`完成 ${task.title}`}
                onClick={() => onToggle(task.id)}
                className={cn(
                  "flex size-4 shrink-0 items-center justify-center border border-input",
                  task.done &&
                    "border-primary bg-primary text-primary-foreground",
                )}
              >
                {task.done ? (
                  <CheckIcon className="size-3" aria-hidden="true" />
                ) : null}
              </button>
              <span
                className={cn(
                  "min-w-0 flex-1 break-words text-sm",
                  task.done && "text-muted-foreground line-through",
                )}
              >
                {task.title}
              </span>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`删除 ${task.title}`}
                onClick={() => onDelete(task.id)}
              >
                <TrashIcon
                  className="text-muted-foreground"
                  aria-hidden="true"
                />
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="py-2 text-sm text-muted-foreground">暂无任务</p>
      )}
    </section>
  );
}
