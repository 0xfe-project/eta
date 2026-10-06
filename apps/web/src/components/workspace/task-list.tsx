import { CheckIcon } from "@phosphor-icons/react/Check";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { ListChecksIcon } from "@phosphor-icons/react/ListChecks";
import { TrashIcon } from "@phosphor-icons/react/Trash";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
          <PlusIcon aria-hidden="true" /> New task
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a task</DialogTitle>
          <DialogDescription>
            A small next step is a good place to start.
          </DialogDescription>
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
            <Label htmlFor="task-title">Task</Label>
            <Input
              id="task-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="What needs to happen?"
              maxLength={200}
              required
            />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={!title.trim()}>
              Add task
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
    <section className="border border-border bg-background">
      <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <ListChecksIcon className="size-4" aria-hidden="true" /> Tasks{" "}
          <span className="ml-1 font-mono text-xs text-muted-foreground">
            {tasks.filter((task) => !task.done).length}
          </span>
        </h3>
        <AddTask onAdd={onAdd} variant="ghost" />
      </header>
      {tasks.length ? (
        <ul className="divide-y divide-border">
          {tasks.map((task) => (
            <li
              key={task.id}
              className="group flex items-center gap-3 px-5 py-4"
            >
              <button
                type="button"
                role="checkbox"
                aria-checked={task.done}
                aria-label={`Complete ${task.title}`}
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
                aria-label={`Delete ${task.title}`}
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
        <div className="px-6 py-12 text-center">
          <ListChecksIcon
            className="mx-auto mb-4 size-7 text-muted-foreground"
            weight="light"
            aria-hidden="true"
          />
          <p className="text-sm font-medium">A clear list. A fresh start.</p>
          <p className="mx-auto mt-2 max-w-64 text-sm leading-6 text-muted-foreground">
            Add your next step here. Small tasks make room for the bigger
            picture.
          </p>
        </div>
      )}
    </section>
  );
}
