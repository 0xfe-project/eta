import { CrownSimpleIcon } from "@phosphor-icons/react/CrownSimple";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useCaptain, useCaptainActions } from "@/queries/captain";
import { useConversation } from "@/queries/conversations";
import { useOutboxActions } from "@/queries/outbox";
import { useTarget } from "@/queries/wire";

export function CaptainDrawer({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const mounted = useTarget("captain") !== undefined;
  const { t: translateText } = useTranslation("captain");
  const captain = useCaptain();
  const captainActions = useCaptainActions();
  const outbox = useOutboxActions();
  const [text, setText] = useState("");
  const [view, setView] = useState<"chat" | "operations">("chat");
  const conversationId =
    captain.identity?.conversationId ??
    captainActions.direct.data?.conversationId;
  const conversation = useConversation(conversationId);
  const messages = useMemo(
    () =>
      conversation.messages.filter(
        (message) =>
          message.author === "user" ||
          message.author === "captain" ||
          message.author === "agent",
      ),
    [conversation.messages],
  );

  useEffect(() => {
    if (!open || captain.identity === null) return;
    if (captain.identity.conversationId !== null) return;
    void captainActions.direct.mutateAsync({});
  }, [captain.identity, captainActions.direct, open]);

  const send = () => {
    const value = text.trim();
    if (
      value === "" ||
      conversationId === undefined ||
      captain.identity === null
    )
      return;
    outbox.send(conversationId, value, "queue", [captain.identity.agentId]);
    setText("");
  };

  if (!mounted) return null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex h-dvh w-full flex-col gap-0 p-0 sm:max-w-md"
      >
        <SheetHeader className="shrink-0 border-b pr-12">
          <SheetTitle className="flex items-center gap-2">
            <CrownSimpleIcon className="size-4" aria-hidden="true" />
            {translateText("title")}
          </SheetTitle>
          <SheetDescription>{translateText("description")}</SheetDescription>
        </SheetHeader>

        <div className="flex shrink-0 gap-1 border-b px-3 py-2">
          <Button
            type="button"
            variant={view === "chat" ? "secondary" : "ghost"}
            size="xs"
            onClick={() => setView("chat")}
          >
            {translateText("tabs.chat")}
          </Button>
          <Button
            type="button"
            variant={view === "operations" ? "secondary" : "ghost"}
            size="xs"
            onClick={() => setView("operations")}
          >
            {translateText("tabs.operations", {
              count:
                captain.operations.filter((item) => item.status === "pending")
                  .length +
                captain.notifications.filter((item) => !item.readAt).length,
            })}
          </Button>
        </div>

        {view === "chat" ? (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              {captain.identity === null ? (
                <div className="space-y-3 text-sm text-muted-foreground">
                  <p>{translateText("notInitialized")}</p>
                  <Button
                    type="button"
                    onClick={() => void captainActions.ensure.mutateAsync({})}
                    disabled={captainActions.ensure.isPending}
                  >
                    {translateText("initialize")}
                  </Button>
                </div>
              ) : messages.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {translateText("empty")}
                </p>
              ) : (
                <ol className="space-y-3">
                  {messages.map((message) => (
                    <li
                      key={message.id}
                      className={cn(
                        "border px-3 py-2 text-sm",
                        message.author === "user" && "ml-6 bg-muted/40",
                        message.author === "captain" &&
                          "mr-6 border-amber-500/40",
                      )}
                    >
                      <div className="mb-1 font-mono text-[10px] text-muted-foreground uppercase">
                        {message.author === "captain"
                          ? translateText("message.captain")
                          : message.author === "agent"
                            ? translateText("message.agent")
                            : translateText("message.user")}
                      </div>
                      <div className="whitespace-pre-wrap">{message.text}</div>
                      {typeof message.data.captainAssignmentId === "string" ? (
                        <p className="mt-2 font-mono text-[10px] text-muted-foreground">
                          {translateText("message.assignment", {
                            round: String(message.data.captainRound ?? 1),
                          })}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ol>
              )}
            </div>
            <div className="shrink-0 border-t p-3">
              <Textarea
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder={translateText("placeholder")}
                rows={3}
                disabled={
                  captain.identity === null || conversationId === undefined
                }
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    send();
                  }
                }}
              />
              <div className="mt-2 flex justify-end">
                <Button
                  type="button"
                  size="sm"
                  onClick={send}
                  disabled={
                    text.trim() === "" ||
                    captain.identity === null ||
                    conversationId === undefined
                  }
                >
                  {translateText("send")}
                </Button>
              </div>
            </div>
          </>
        ) : (
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
            <section>
              <h3 className="mb-2 text-xs font-medium">
                {translateText("operations.pending")}
              </h3>
              {!captain.operations.some((item) => item.status === "pending") ? (
                <p className="text-xs text-muted-foreground">
                  {translateText("operations.none")}
                </p>
              ) : (
                <ul className="space-y-2">
                  {captain.operations
                    .filter((item) => item.status === "pending")
                    .map((operation) => (
                      <li key={operation.id} className="border p-2">
                        <div className="font-mono text-[10px] text-muted-foreground">
                          {operation.kind}
                        </div>
                        <div className="mt-2 flex gap-2">
                          <Button
                            type="button"
                            size="xs"
                            onClick={() =>
                              void captainActions.decideOperation.mutateAsync({
                                operationId: operation.id,
                                decision: "approve",
                              })
                            }
                          >
                            {translateText("operations.approve")}
                          </Button>
                          <Button
                            type="button"
                            size="xs"
                            variant="ghost"
                            onClick={() =>
                              void captainActions.decideOperation.mutateAsync({
                                operationId: operation.id,
                                decision: "reject",
                              })
                            }
                          >
                            {translateText("operations.reject")}
                          </Button>
                        </div>
                      </li>
                    ))}
                </ul>
              )}
            </section>

            <section>
              <h3 className="mb-2 text-xs font-medium">
                {translateText("notifications.title")}
              </h3>
              {captain.notifications.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {translateText("notifications.none")}
                </p>
              ) : (
                <ul className="space-y-2">
                  {captain.notifications.map((notification) => (
                    <li
                      key={notification.id}
                      className={cn(
                        "border p-2 text-xs",
                        notification.readAt === null && "border-amber-500/40",
                      )}
                    >
                      <div>{notification.body}</div>
                      {notification.readAt === null ? (
                        <Button
                          type="button"
                          size="xs"
                          variant="ghost"
                          className="mt-1"
                          onClick={() =>
                            void captainActions.markNotificationRead.mutateAsync(
                              { notificationId: notification.id },
                            )
                          }
                        >
                          {translateText("notifications.markRead")}
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section>
              <h3 className="mb-2 text-xs font-medium">
                {translateText("assignments.title")}
              </h3>
              {captain.assignments.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {translateText("assignments.none")}
                </p>
              ) : (
                <ul className="space-y-2">
                  {captain.assignments.slice(0, 20).map((assignment) => (
                    <li key={assignment.id} className="border p-2 text-xs">
                      <div className="flex justify-between gap-2">
                        <span>round {assignment.round}</span>
                        <span className="font-mono">{assignment.status}</span>
                      </div>
                      <div className="mt-1 text-muted-foreground">
                        {assignment.targets
                          .map(
                            (target) =>
                              `${target.agentId.slice(0, 8)}: ${target.status} · ${target.taskCount}`,
                          )
                          .join(" / ")}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

export function CaptainMenuItem({ rail }: { rail: boolean }) {
  const [open, setOpen] = useState(false);
  const mounted = useTarget("captain") !== undefined;
  const captain = useCaptain();
  const { t: translateText } = useTranslation("navigation");
  const count =
    captain.operations.filter((item) => item.status === "pending").length +
    captain.notifications.filter((item) => !item.readAt).length;
  const label = translateText("sections.captain");
  if (!mounted) return null;
  return (
    <>
      <button
        type="button"
        title={label}
        aria-label={count === 0 ? label : `${label} · ${count}`}
        className={cn(
          "relative flex h-8 w-full items-center gap-2 px-2 text-left text-sm",
          rail && "justify-center px-0",
        )}
        onClick={() => setOpen(true)}
      >
        <CrownSimpleIcon className="size-4 shrink-0" aria-hidden="true" />
        {rail ? null : <span>{label}</span>}
        {count > 0 ? (
          <span
            className={cn(
              "ml-auto font-mono text-[10px] tabular-nums",
              rail && "absolute top-0 right-0",
            )}
          >
            {count}
          </span>
        ) : null}
      </button>
      <CaptainDrawer open={open} onOpenChange={setOpen} />
    </>
  );
}
