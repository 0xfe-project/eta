import type {
  EmailMessageView,
  EmailResults,
  EmailThreadView,
} from "@eta/client-contracts";
import type { EmailFolder } from "@/components/workspace/email-folders";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/ArrowClockwise";
import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { EnvelopeSimpleIcon } from "@phosphor-icons/react/EnvelopeSimple";
import { PaperPlaneRightIcon } from "@phosphor-icons/react/PaperPlaneRight";
import { TrashIcon } from "@phosphor-icons/react/Trash";
import { useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Empty, LoadError, Loading } from "@/components/states";
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
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/workspace/app-shell";
import { emailThreadsForFolder } from "@/components/workspace/email-folders";
import { EmailMessageHtml } from "@/components/workspace/email-message-html";
import { EmailMetaPanel } from "@/components/workspace/email-meta";
import { useEmailNav } from "@/components/workspace/email-nav";
import { EmailSessionLog } from "@/components/workspace/email-session-log";
import { Select, SelectOption } from "@/components/workspace/select-field";
import { useGroups } from "@/components/workspace/use-groups";
import { formatLocale } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useAgentList } from "@/queries/agents";
import {
  useAssignEmail,
  useDeleteEmails,
  useEmail,
  useEmailThread,
  useMarkEmailRead,
  useRefreshEmail,
} from "@/queries/email";
import { useProjects } from "@/queries/projects";
import { useWireState, wireErrorMessage } from "@/queries/wire";

function time(value: number): string {
  return new Intl.DateTimeFormat(formatLocale(), {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value);
}

const etaMail = (subject: string) => /^\[eta-mp\]\s*/i.test(subject);

function previewText(value: string): string {
  const entities: Record<string, string> = {
    "&nbsp;": " ",
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
  };
  return value
    .replace(/<(style|script)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(
      /&(?:nbsp|amp|lt|gt|quot|#39);/g,
      (entity) => entities[entity] ?? " ",
    )
    .replace(/\{[^{}]{0,400}\}/g, " ")
    .replace(
      /\b(?:font|font-family|font-size|margin|padding|border|color|background|display|width|height|line-height|text-align|text-decoration)\s*:[^;{}]+[;}]?/gi,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
}

function messageStatus(
  status: EmailMessageView["status"],
  t: (key: string) => string,
): string {
  switch (status) {
    case "received":
      return t("thread.statusReceived");
    case "draft":
      return t("thread.statusDraft");
    case "sending":
      return t("thread.statusSending");
    case "accepted":
      return t("thread.statusAccepted");
    case "failed":
      return t("thread.statusFailed");
  }
}

function ThreadRow({
  thread,
  count,
  selected,
  checked,
  onCheckedChange,
  onOpen,
}: {
  thread: EmailThreadView;
  count: number;
  selected: boolean;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  onOpen: () => void;
}) {
  const { t } = useTranslation(["email"] as const);
  const eta = etaMail(thread.subject);
  const subject = thread.subject || t("inbox.noSubject");
  return (
    <div
      className={cn(
        "flex w-full items-start gap-2 border-b px-2 py-2.5 transition-colors duration-[60ms] ease-linear",
        selected ? "bg-muted" : "hover:bg-muted/60",
        eta && "border-l-2 border-l-foreground pl-1.5",
        eta && !selected && "bg-muted/25",
      )}
    >
      <Checkbox
        className="mt-1"
        checked={checked}
        onCheckedChange={(value) => onCheckedChange(value === true)}
        aria-label={subject}
      />
      <button
        type="button"
        onClick={onOpen}
        className="min-w-0 flex-1 text-left"
      >
        <span className="flex items-baseline gap-2">
          <span
            className={cn(
              "flex min-w-0 flex-1 items-center gap-1.5 text-sm",
              (thread.unread || eta) && "font-semibold",
            )}
          >
            {eta ? (
              <span
                className="shrink-0 bg-foreground px-1 py-0.5 font-mono text-[9px] leading-none text-background"
                aria-label={t("thread.etaMail")}
              >
                ETA
              </span>
            ) : null}
            <span className="truncate">{subject}</span>
          </span>
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {time(thread.lastMessageAt)}
          </span>
        </span>
        <span className="mt-1 flex gap-2 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">{thread.peer}</span>
          <span>{count}</span>
        </span>
        <span className="mt-1 block truncate text-xs text-muted-foreground">
          {previewText(thread.lastMessage) || t("inbox.htmlMessage")}
        </span>
      </button>
    </div>
  );
}

function Message({ message }: { message: EmailMessageView }) {
  const { t } = useTranslation(["email"] as const);
  const meta = message.meta;
  const hasEtaMeta =
    meta !== null &&
    (meta.protocol !== null ||
      meta.agentId !== null ||
      meta.agentName !== null ||
      meta.sessionId !== null ||
      meta.packetCount > 0);
  return (
    <article className="border-b py-4 last:border-b-0 sm:py-5">
      <div className="mb-3 flex flex-wrap items-start gap-2">
        <span className="mt-0.5 bg-muted px-2 py-1 font-mono text-[10px]">
          {message.direction === "incoming" ? "IN" : "OUT"}
        </span>
        <div className="min-w-0 flex-1">
          <h3
            className="line-clamp-2 text-sm font-semibold"
            title={message.subject}
          >
            {message.subject || t("inbox.noSubject")}
          </h3>
          <p className="truncate text-xs text-muted-foreground">
            {message.from} → {message.to} · {time(message.createdAt)}
          </p>
        </div>
        <span className="text-[11px] text-muted-foreground">
          {messageStatus(message.status, t)}
        </span>
      </div>
      <EmailMessageHtml
        html={message.html}
        text={message.text}
        title={message.subject}
      />
      <details className="group/rfc mt-3 border">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-[11px] [&::-webkit-details-marker]:hidden">
          <CaretDownIcon
            aria-hidden="true"
            className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open/rfc:rotate-180"
          />
          <span className="shrink-0 font-medium">{t("thread.rfcHeaders")}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground">
            {message.rfcMessageId ?? "—"}
          </span>
        </summary>
        <dl className="grid grid-cols-[5rem_minmax(0,1fr)] gap-x-2 gap-y-1 border-t px-3 py-2 text-[11px] sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-x-3">
          <dt className="text-muted-foreground">{t("thread.messageId")}</dt>
          <dd className="break-all font-mono">{message.rfcMessageId ?? "—"}</dd>
          <dt className="text-muted-foreground">{t("thread.inReplyTo")}</dt>
          <dd className="break-all font-mono">{message.inReplyTo ?? "—"}</dd>
          <dt className="text-muted-foreground">{t("thread.references")}</dt>
          <dd className="break-all font-mono">
            {message.references.join(" ") || "—"}
          </dd>
        </dl>
      </details>
      {meta && hasEtaMeta ? <EmailMetaPanel meta={meta} /> : null}
    </article>
  );
}

function AssignDialog({
  threads,
  open,
  onOpenChange,
  onAssigned,
}: {
  threads: readonly EmailThreadView[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAssigned?: (result: EmailResults["assign"]) => void;
}) {
  const { t } = useTranslation(["email", "common"] as const);
  const { agents } = useAgentList();
  const { projects } = useProjects();
  const assign = useAssignEmail();
  const [agentId, setAgentId] = useState("");
  const [projectId, setProjectId] = useState("");
  const agentFieldId = useId();
  const projectFieldId = useId();
  const start = () => {
    const first = threads[0];
    if (!first) return;
    if (!agentId || !projectId) return;
    assign.mutate(
      { threadIds: threads.map((thread) => thread.id), agentId, projectId },
      {
        onSuccess: (result) => {
          toast.success(t("thread.assignedTo", { name: result.agentName }));
          onOpenChange(false);
          onAssigned?.(result);
        },
        onError: (error) => toast.error(wireErrorMessage(error)),
      },
    );
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {threads.length > 1
              ? t("thread.assignCount", { count: threads.length })
              : t("thread.handoff")}
          </DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1">
            <Label
              htmlFor={agentFieldId}
              className="text-xs text-muted-foreground"
            >
              {t("thread.agent")}
            </Label>
            <Select
              id={agentFieldId}
              className="w-full"
              value={agentId}
              onValueChange={setAgentId}
            >
              {agents.map((agent) => (
                <SelectOption key={agent.id} value={agent.id}>
                  {agent.name}
                </SelectOption>
              ))}
            </Select>
          </div>
          <div className="grid gap-1">
            <Label
              htmlFor={projectFieldId}
              className="text-xs text-muted-foreground"
            >
              {t("thread.project")}
            </Label>
            <Select
              id={projectFieldId}
              className="w-full"
              value={projectId}
              onValueChange={setProjectId}
            >
              {projects.map((project) => (
                <SelectOption key={project.id} value={project.id}>
                  {project.name} · {project.path}
                </SelectOption>
              ))}
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button
            disabled={!agentId || !projectId || assign.isPending}
            onClick={start}
          >
            {t("thread.assign")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function EmailInboxPage() {
  const { t } = useTranslation(["email", "common"] as const);
  const email = useEmail();
  const [search, setSearch] = useEmailNav();
  const selected = search.thread;
  const detail = useEmailThread(selected ?? undefined);
  const refresh = useRefreshEmail();
  const read = useMarkEmailRead();
  const removeThreads = useDeleteEmails();
  const [assignOpen, setAssignOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [assignThreads, setAssignThreads] = useState<EmailThreadView[]>([]);
  const [checked, setChecked] = useState<string[]>([]);
  const [folder, setFolder] = useState<EmailFolder>("inbox");
  const { agents } = useAgentList();
  const { projects } = useProjects();
  const { groups } = useGroups();
  const navigate = useNavigate();
  const connecting = useWireState((state) => state.status === "connecting");
  if (!email.mounted)
    return (
      <>
        <PageHeader title={t("title")} />
        <main id="main" className="min-h-0 flex-1">
          {connecting ? (
            <Loading />
          ) : (
            <LoadError
              what={t("title")}
              error={new Error("email plugin is not mounted")}
            />
          )}
        </main>
      </>
    );
  const visibleThreads = emailThreadsForFolder(email.threads, folder);
  const chooseFolder = (next: EmailFolder) => {
    setFolder(next);
    setChecked([]);
    if (selected !== null) void setSearch({ thread: null });
  };
  return (
    <>
      <PageHeader title={t("title")}>
        <Button
          variant="outline"
          size="sm"
          disabled={refresh.isPending}
          onClick={() =>
            refresh.mutate(
              {},
              { onError: (error) => toast.error(wireErrorMessage(error)) },
            )
          }
        >
          <ArrowClockwiseIcon />
          {t("inbox.refresh")}
        </Button>
      </PageHeader>
      <main
        id="main"
        className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[22rem_minmax(0,1fr)]"
      >
        <aside
          className={cn(
            "min-h-0 overflow-y-auto border-r",
            selected !== null && "hidden md:block",
          )}
        >
          <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b bg-background px-3 py-2">
            <EnvelopeSimpleIcon className="size-4 shrink-0" />
            <Tabs
              value={folder}
              onValueChange={(value) => chooseFolder(value as EmailFolder)}
            >
              <TabsList>
                <TabsTrigger value="inbox">{t("inbox.title")}</TabsTrigger>
                <TabsTrigger value="sent">{t("inbox.sent")}</TabsTrigger>
              </TabsList>
            </Tabs>
            <span className="ml-auto shrink-0 whitespace-nowrap text-xs text-muted-foreground">
              {checked.length > 0
                ? t("inbox.selected", { count: checked.length })
                : visibleThreads.length}
            </span>
            {checked.length > 0 ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  className="shrink-0 whitespace-nowrap"
                  onClick={() => setDeleteOpen(true)}
                >
                  <TrashIcon />
                  {t("inbox.delete")}
                </Button>
                <Button
                  size="sm"
                  className="shrink-0 whitespace-nowrap"
                  onClick={() => {
                    setAssignThreads(
                      email.threads.filter((thread) =>
                        checked.includes(thread.id),
                      ),
                    );
                    setAssignOpen(true);
                  }}
                >
                  {t("thread.assignCount", { count: checked.length })}
                </Button>
              </>
            ) : null}
          </div>
          {!email.loaded ? (
            <Loading />
          ) : folder === "inbox" && email.accounts.length === 0 ? (
            <Empty
              icon={EnvelopeSimpleIcon}
              title={t("inbox.noAccount")}
              action={
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    void navigate({
                      to: "/settings",
                      search: { section: "email" },
                    })
                  }
                >
                  {t("add")}
                </Button>
              }
            />
          ) : visibleThreads.length === 0 ? (
            <Empty
              icon={EnvelopeSimpleIcon}
              title={
                folder === "inbox" ? t("inbox.empty") : t("inbox.sentEmpty")
              }
            />
          ) : (
            visibleThreads.map((thread) => (
              <ThreadRow
                key={thread.id}
                thread={thread}
                count={
                  folder === "inbox"
                    ? (thread.incomingCount ?? thread.messageCount)
                    : (thread.outgoingCount ?? thread.messageCount)
                }
                selected={selected === thread.id}
                checked={checked.includes(thread.id)}
                onCheckedChange={(value) =>
                  setChecked((current) =>
                    value
                      ? [...new Set([...current, thread.id])]
                      : current.filter((id) => id !== thread.id),
                  )
                }
                onOpen={() => {
                  void setSearch({ thread: thread.id });
                  if (thread.unread)
                    read.mutate({ threadId: thread.id, unread: false });
                }}
              />
            ))
          )}
        </aside>
        <section
          className={cn(
            "min-h-0 overflow-y-auto",
            selected === null && "hidden md:block",
          )}
        >
          {selected === null ? (
            <div className="grid h-full place-items-center p-8 text-sm text-muted-foreground">
              {t("thread.noMessages")}
            </div>
          ) : !detail.thread ? (
            <Loading />
          ) : (
            <div className="mx-auto max-w-content px-4 pb-12">
              <header className="sticky top-0 z-10 -mx-4 border-b bg-background px-4 py-3">
                <div className="flex items-start gap-2 sm:gap-3">
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    className="md:hidden"
                    aria-label={t("common:actions.back")}
                    onClick={() => void setSearch({ thread: null })}
                  >
                    <ArrowLeftIcon />
                  </Button>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      {etaMail(detail.thread.subject) ? (
                        <span className="shrink-0 bg-foreground px-1.5 py-0.5 font-mono text-[10px] leading-none text-background">
                          ETA
                        </span>
                      ) : null}
                      <h1
                        className="line-clamp-2 text-base font-semibold leading-tight sm:text-lg"
                        title={detail.thread.subject}
                      >
                        {detail.thread.subject || t("inbox.noSubject")}
                      </h1>
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                      {detail.thread.peer}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    className="shrink-0 px-2 sm:px-3"
                    aria-label={t("thread.handoff")}
                    onClick={() => {
                      setAssignThreads([detail.thread!]);
                      setAssignOpen(true);
                    }}
                  >
                    <PaperPlaneRightIcon />
                    <span className="hidden sm:inline">
                      {t("thread.handoff")}
                    </span>
                  </Button>
                </div>
              </header>
              {detail.assignments.map((assignment) => (
                <details key={assignment.id} className="group border-b py-3">
                  <summary className="flex cursor-pointer list-none items-start gap-3 [&::-webkit-details-marker]:hidden">
                    <div className="min-w-0 flex-1">
                      <h2 className="text-sm font-semibold">
                        {t("thread.processingBy")} ·{" "}
                        {agents.find((agent) => agent.id === assignment.agentId)
                          ?.name ?? assignment.agentId}
                      </h2>
                      <p className="truncate text-xs text-muted-foreground">
                        {t("thread.project")}:{" "}
                        {projects.find(
                          (project) => project.id === assignment.projectId,
                        )?.name ?? assignment.projectId}
                      </p>
                    </div>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {t("thread.expandProcessing")}
                    </span>
                    <CaretDownIcon
                      aria-hidden="true"
                      className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
                    />
                  </summary>
                  <div className="mt-3 space-y-3">
                    {(() => {
                      const conversation = groups.find((group) =>
                        group.participants.some(
                          (participant) =>
                            participant.sessionId === assignment.sessionId,
                        ),
                      );
                      return conversation ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            void navigate({
                              to: "/",
                              search: { group: conversation.id },
                            })
                          }
                        >
                          {t("thread.openSession")}
                        </Button>
                      ) : null;
                    })()}
                    <EmailSessionLog
                      sessionId={assignment.sessionId}
                      startedAt={assignment.createdAt}
                    />
                  </div>
                </details>
              ))}
              {detail.messages.map((message) => (
                <Message key={message.id} message={message} />
              ))}
            </div>
          )}
        </section>
      </main>
      <AssignDialog
        threads={assignThreads}
        open={assignOpen}
        onOpenChange={setAssignOpen}
        onAssigned={(result) => {
          setChecked([]);
          void navigate({
            to: "/",
            search: { group: result.conversationId },
          });
        }}
      />
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("inbox.deleteTitle", { count: checked.length })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("inbox.deleteDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={removeThreads.isPending}
              onClick={() => {
                const deleting = checked;
                removeThreads.mutate(
                  { threadIds: deleting },
                  {
                    onSuccess: ({ threadIds }) => {
                      setChecked((current) =>
                        current.filter((id) => !threadIds.includes(id)),
                      );
                      if (selected !== null && threadIds.includes(selected)) {
                        void setSearch({ thread: null });
                      }
                      toast.success(
                        t("inbox.deleted", {
                          count: threadIds.length,
                        }),
                      );
                    },
                    onError: (error) => toast.error(wireErrorMessage(error)),
                  },
                );
              }}
            >
              {t("inbox.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
