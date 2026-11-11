import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useCaptain, useCaptainActions } from "@/queries/captain";
import { Section } from "./panel-section";

/**
 * Operations: the three things about Captain's work that a chat cannot carry — an approval it cannot give
 * itself, an alert it raised, and what it handed out recently.
 *
 * They used to be the second tab of a drawer that held the whole of Captain. The drawer is gone
 * (the conversation is the chat, the head of the sidebar is its card), and this is the half of it
 * that had nowhere to land: a pending approval is something a person has to do, and it cannot live in a
 * tab nobody drew. It goes in the context panel of Captain's own conversation — the one column in
 * the window that is *about* a conversation rather than in it.
 */
export function CaptainOperations() {
  const { t: translateText } = useTranslation("captain");
  const captain = useCaptain();
  const actions = useCaptainActions();
  const pending = captain.operations.filter(
    (item) => item.status === "pending",
  );
  const unread = captain.notifications.filter((item) => item.readAt === null);

  return (
    <>
      <Section
        title={translateText("operations.pending")}
        count={pending.length}
      >
        {pending.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {translateText("operations.none")}
          </p>
        ) : (
          // Rows, edge to edge, as tasks and artifacts draw theirs: the rule between two runs into the
          // panel's own edges, so the block reads as part of the column and not as cards on it.
          <ul className="-mx-3 divide-y divide-border">
            {pending.map((operation) => (
              <li key={operation.id} className="px-3 py-1.5">
                <div className="font-mono text-[10px] text-muted-foreground">
                  {operation.kind}
                </div>
                <div className="mt-1 flex gap-2">
                  <Button
                    type="button"
                    size="xs"
                    onClick={() =>
                      void actions.decideOperation.mutateAsync({
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
                      void actions.decideOperation.mutateAsync({
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
      </Section>

      <Section
        title={translateText("notifications.title")}
        count={unread.length}
      >
        {captain.notifications.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {translateText("notifications.none")}
          </p>
        ) : (
          <ul className="-mx-3 divide-y divide-border">
            {captain.notifications.map((notification) => (
              <li key={notification.id} className="px-3 py-1.5">
                <p
                  className={cn(
                    "text-xs",
                    notification.readAt === null && "text-foreground",
                    notification.readAt !== null && "text-muted-foreground",
                  )}
                >
                  {notification.body}
                </p>
                {notification.readAt === null ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    className="mt-1 -ml-2"
                    onClick={() =>
                      void actions.markNotificationRead.mutateAsync({
                        notificationId: notification.id,
                      })
                    }
                  >
                    {translateText("notifications.markRead")}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title={translateText("assignments.title")}
        count={captain.assignments.length}
      >
        {captain.assignments.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {translateText("assignments.none")}
          </p>
        ) : (
          <ul className="-mx-3 divide-y divide-border">
            {captain.assignments.slice(0, 20).map((assignment) => (
              <li key={assignment.id} className="px-3 py-1.5 text-xs">
                <div className="flex justify-between gap-2">
                  <span>
                    {translateText("assignments.round", {
                      round: assignment.round,
                    })}
                  </span>
                  <span className="font-mono text-[10px] text-faint">
                    {assignment.status}
                  </span>
                </div>
                <p className="mt-0.5 text-muted-foreground">
                  {assignment.targets
                    .map(
                      (target) =>
                        `${target.agentId.slice(0, 8)}: ${target.status} · ${target.taskCount}`,
                    )
                    .join(" / ")}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}
