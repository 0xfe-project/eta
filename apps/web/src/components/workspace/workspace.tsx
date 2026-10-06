import { SquaresFourIcon } from "@phosphor-icons/react/SquaresFour";
import { ListChecksIcon } from "@phosphor-icons/react/ListChecks";
import { BrainIcon } from "@phosphor-icons/react/Brain";
import { LightningIcon } from "@phosphor-icons/react/Lightning";
import { ArrowUpRightIcon } from "@phosphor-icons/react/ArrowUpRight";
import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";
import { PencilSimpleIcon } from "@phosphor-icons/react/PencilSimple";
import { ChatCircleIcon } from "@phosphor-icons/react/ChatCircle";
import { PlugsIcon } from "@phosphor-icons/react/Plugs";
import { FileTextIcon } from "@phosphor-icons/react/FileText";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { z } from "zod";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Markdown } from "@/components/markdown";
import { cn } from "@/lib/utils";
import { healthQueryOptions } from "@/queries/health";
import { ChatPanel } from "./chat-panel";
import { TaskList, AddTask } from "./task-list";
import type { WorkspaceView } from "./types";

const views = [
  { value: "overview", label: "Overview", icon: SquaresFourIcon },
  { value: "tasks", label: "Tasks", icon: ListChecksIcon },
  { value: "memory", label: "Memory", icon: BrainIcon },
  { value: "capabilities", label: "Capabilities", icon: LightningIcon },
] as const;
const storageKey = "axp.workspace.v1";
const workspaceSchema = z.object({
  messages: z.array(
    z.object({ id: z.string(), content: z.string().max(10_000) }),
  ),
  tasks: z.array(
    z.object({ id: z.string(), title: z.string().max(200), done: z.boolean() }),
  ),
  memory: z.string().max(10_000),
});
const initialWorkspace: z.infer<typeof workspaceSchema> = {
  messages: [],
  tasks: [],
  memory: "",
};

export function Workspace({
  view,
  onViewChange,
}: {
  view: WorkspaceView;
  onViewChange: (view: WorkspaceView) => void;
}) {
  const [workspace, setWorkspace] = useState(initialWorkspace);
  const [loaded, setLoaded] = useState(false);
  const [mobilePanel, setMobilePanel] = useState<"chat" | "workspace">("chat");
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [memoryDraft, setMemoryDraft] = useState("");
  const health = useQuery(healthQueryOptions());
  useEffect(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const result = workspaceSchema.safeParse(JSON.parse(saved));
        if (result.success) setWorkspace(result.data);
      }
    } catch {
      /* Storage may be unavailable in private browsing. */
    }
    setLoaded(true);
  }, []);
  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify(workspace));
    } catch {
      toast.error(
        "Unable to save in this browser. Keep this page open to retain your work.",
      );
    }
  }, [workspace, loaded]);

  function addTask(title: string) {
    setWorkspace((state) => ({
      ...state,
      tasks: [...state.tasks, { id: crypto.randomUUID(), title, done: false }],
    }));
  }
  const tasksProps = {
    tasks: workspace.tasks,
    onAdd: addTask,
    onToggle: (id: string) =>
      setWorkspace((state) => ({
        ...state,
        tasks: state.tasks.map((task) =>
          task.id === id ? { ...task, done: !task.done } : task,
        ),
      })),
    onDelete: (id: string) =>
      setWorkspace((state) => ({
        ...state,
        tasks: state.tasks.filter((task) => task.id !== id),
      })),
  };

  const memoryCard = (
    <section className="flex min-h-64 flex-col border border-border bg-background">
      <header className="flex items-center justify-between border-b border-border px-5 py-4">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <BrainIcon className="size-4" aria-hidden="true" /> Your context
        </h3>
        <Dialog
          open={memoryOpen}
          onOpenChange={(open) => {
            setMemoryOpen(open);
            if (open) setMemoryDraft(workspace.memory);
          }}
        >
          <DialogTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Edit context">
              <PencilSimpleIcon aria-hidden="true" />
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Your context</DialogTitle>
              <DialogDescription>
                Keep useful preferences and project notes close at hand. Saved
                only in this browser.
              </DialogDescription>
            </DialogHeader>
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                setWorkspace((state) => ({
                  ...state,
                  memory: memoryDraft.trim(),
                }));
                setMemoryOpen(false);
                toast.success("Context saved");
              }}
            >
              <Label htmlFor="memory">Notes</Label>
              <Textarea
                id="memory"
                className="min-h-40"
                value={memoryDraft}
                maxLength={10_000}
                onChange={(event) => setMemoryDraft(event.target.value)}
                placeholder="What would be helpful to remember?"
              />
              <DialogFooter>
                <Button type="submit">Save context</Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </header>
      <div className="flex flex-1 flex-col justify-center p-5">
        {workspace.memory ? (
          <Markdown>{workspace.memory}</Markdown>
        ) : (
          <>
            <p className="text-sm font-medium">
              Less repeating.
              <br />
              More understanding.
            </p>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">
              Your preferences, projects, and the details that matter. Add a
              note to make this space yours.
            </p>
          </>
        )}
      </div>
      <p className="border-t border-border px-5 py-3 text-xs text-muted-foreground">
        Private to this browser
      </p>
    </section>
  );

  return (
    <div className="flex h-dvh min-h-0 flex-col bg-background">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-5 sm:px-6">
        <div className="flex items-center gap-4">
          <h1 className="text-xl font-semibold tracking-tight">
            axp<span className="text-muted-foreground">.</span>
          </h1>
          <span className="h-4 border-l border-border" />
          <span className="text-xs text-muted-foreground">
            Personal workspace
          </span>
        </div>
        <div className="flex items-center gap-5">
          <span
            className="hidden items-center gap-2 text-xs text-muted-foreground sm:flex"
            role="status"
          >
            <span
              className={cn(
                "size-1.5 bg-muted-foreground",
                health.isSuccess && "bg-foreground",
              )}
            />
            {health.isPending
              ? "Connecting"
              : health.isError
                ? "Control plane offline"
                : "Control plane online"}
          </span>
          <span
            className="flex size-7 items-center justify-center border border-border text-xs"
            aria-label="Eric"
          >
            E
          </span>
        </div>
      </header>
      <div
        className="grid grid-cols-2 border-b border-border md:hidden"
        aria-label="Workspace panels"
      >
        <Button
          variant="ghost"
          className={cn(
            "h-10 border-b-2 border-transparent",
            mobilePanel === "chat" && "border-foreground",
          )}
          onClick={() => setMobilePanel("chat")}
          aria-pressed={mobilePanel === "chat"}
        >
          <ChatCircleIcon aria-hidden="true" /> Chat
        </Button>
        <Button
          variant="ghost"
          className={cn(
            "h-10 border-b-2 border-transparent",
            mobilePanel === "workspace" && "border-foreground",
          )}
          onClick={() => setMobilePanel("workspace")}
          aria-pressed={mobilePanel === "workspace"}
        >
          <SquaresFourIcon aria-hidden="true" /> Workspace
        </Button>
      </div>
      <main
        id="main"
        className="grid min-h-0 flex-1 md:grid-cols-[minmax(320px,36%)_minmax(0,1fr)] xl:grid-cols-[400px_minmax(0,1fr)]"
      >
        <div
          className={cn(
            "min-h-0 min-w-0 border-r border-border",
            mobilePanel === "workspace" && "hidden md:block",
          )}
        >
          <ChatPanel
            messages={workspace.messages}
            onSend={(content) =>
              setWorkspace((state) => ({
                ...state,
                messages: [
                  ...state.messages,
                  { id: crypto.randomUUID(), content },
                ],
              }))
            }
            onNewChat={() =>
              setWorkspace((state) => ({ ...state, messages: [] }))
            }
          />
        </div>
        <Tabs
          value={view}
          onValueChange={(value) => onViewChange(value as WorkspaceView)}
          className={cn(
            "min-h-0 min-w-0 gap-0 bg-muted/35",
            mobilePanel === "chat" && "hidden md:flex",
          )}
        >
          <div className="flex h-14 shrink-0 items-center justify-center border-b border-border bg-background px-3 sm:justify-start sm:px-6">
            <TabsList
              variant="line"
              aria-label="Workspace sections"
              className="h-full gap-1 p-0 sm:gap-4"
            >
              {views.map(({ value, label, icon: Icon }) => (
                <TabsTrigger
                  key={value}
                  value={value}
                  className="h-full gap-2 px-2 text-xs after:bottom-0 sm:px-3"
                >
                  <Icon className="hidden size-4 sm:block" aria-hidden="true" />
                  {label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-8 sm:px-8 lg:px-10 lg:py-10">
            <TabsContent
              value="overview"
              className="mx-auto max-w-5xl space-y-7"
            >
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p className="mb-2 text-sm text-muted-foreground">
                    A fresh start
                  </p>
                  <h2 className="text-3xl font-medium tracking-tight">
                    Good to see you, Eric.
                  </h2>
                  <p className="mt-3 text-sm leading-6 text-muted-foreground">
                    A little context. A clear next step. Your space to move
                    things forward.
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-4 border-y border-border py-4">
                <span className="text-sm">
                  {workspace.tasks.filter((task) => !task.done).length} open
                  tasks <span className="mx-2 text-muted-foreground">/</span>{" "}
                  {workspace.messages.length}{" "}
                  {workspace.messages.length === 1 ? "message" : "messages"}
                </span>
                <Button variant="ghost" onClick={() => onViewChange("tasks")}>
                  View tasks <ArrowRightIcon aria-hidden="true" />
                </Button>
              </div>
              <div className="grid gap-5 xl:grid-cols-[1.25fr_1fr]">
                <TaskList {...tasksProps} />
                {memoryCard}
              </div>
              <section className="flex flex-col items-start justify-between gap-4 border border-border bg-background px-5 py-5 sm:flex-row sm:items-center">
                <div className="flex gap-4">
                  <PlugsIcon
                    className="mt-0.5 size-5 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <div>
                    <h3 className="text-sm font-medium">
                      Give your agent room to work
                    </h3>
                    <p className="mt-1.5 text-sm text-muted-foreground">
                      Tools and connections will live here.
                    </p>
                  </div>
                </div>
                <Button
                  variant="outline"
                  onClick={() => onViewChange("capabilities")}
                >
                  Explore capabilities <ArrowUpRightIcon aria-hidden="true" />
                </Button>
              </section>
              <p className="text-xs text-muted-foreground">
                Local preview. Your conversations, tasks, and notes stay in this
                browser.
              </p>
            </TabsContent>
            <TabsContent value="tasks" className="mx-auto max-w-4xl space-y-7">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h2 className="text-2xl font-medium">One step at a time.</h2>
                  <p className="mt-2 text-sm text-muted-foreground">
                    Keep your next actions in sight.
                  </p>
                </div>
                <AddTask onAdd={addTask} variant="default" />
              </div>
              <TaskList {...tasksProps} />
            </TabsContent>
            <TabsContent value="memory" className="mx-auto max-w-3xl space-y-7">
              <div>
                <h2 className="text-2xl font-medium">
                  The context that matters.
                </h2>
                <p className="mt-2 text-sm text-muted-foreground">
                  A place for details you don't want to explain twice.
                </p>
              </div>
              {memoryCard}
            </TabsContent>
            <TabsContent
              value="capabilities"
              className="mx-auto max-w-4xl space-y-7"
            >
              <div>
                <h2 className="text-2xl font-medium">
                  From conversation to action.
                </h2>
                <p className="mt-2 text-sm text-muted-foreground">
                  Your workspace is ready. Agent execution is the next
                  connection.
                </p>
              </div>
              <div className="divide-y divide-border border border-border bg-background">
                {[
                  {
                    icon: FileTextIcon,
                    title: "Workspace",
                    description: "Conversations, tasks, and Markdown notes.",
                    status: "Available locally",
                  },
                  {
                    icon: LightningIcon,
                    title: "Agent runtime",
                    description: "Model responses and task execution.",
                    status: "Not connected",
                  },
                  {
                    icon: PlugsIcon,
                    title: "Connected tools",
                    description: "Work with your apps, files, and services.",
                    status: "Not connected",
                  },
                ].map(({ icon: Icon, title, description, status }) => (
                  <div
                    key={title}
                    className="flex flex-wrap items-center gap-4 p-5"
                  >
                    <Icon
                      className="size-5 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <div className="min-w-0 flex-1">
                      <h3 className="text-sm font-medium">{title}</h3>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {description}
                      </p>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {status}
                    </span>
                  </div>
                ))}
              </div>
            </TabsContent>
          </div>
        </Tabs>
      </main>
    </div>
  );
}
