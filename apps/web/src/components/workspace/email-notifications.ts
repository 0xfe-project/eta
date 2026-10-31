import type { EmailThreadView } from "@eta/client-contracts";
import { EnvelopeSimpleIcon } from "@phosphor-icons/react/EnvelopeSimple";
import { useNavigate } from "@tanstack/react-router";
import { createElement, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useEmail } from "@/queries/email";

interface SeenThread {
  lastMessageAt: number;
  incomingCount: number | undefined;
}

const isEtaMail = (thread: EmailThreadView) =>
  /^\[eta-mp\]\s*/i.test(thread.subject);

export function newEtaMailThreads(
  previous: ReadonlyMap<string, SeenThread>,
  threads: readonly EmailThreadView[],
  initialized: boolean,
): EmailThreadView[] {
  if (!initialized) return [];
  return threads.filter((thread) => {
    if (!isEtaMail(thread)) return false;
    const seen = previous.get(thread.id);
    if (seen === undefined) {
      return typeof thread.incomingCount === "number"
        ? thread.incomingCount > 0
        : thread.unread;
    }
    if (
      typeof thread.incomingCount === "number" &&
      typeof seen.incomingCount === "number"
    ) {
      return thread.incomingCount > seen.incomingCount;
    }
    return thread.lastMessageAt > seen.lastMessageAt && thread.unread;
  });
}

export function useEtaMailNotifications(): void {
  const navigate = useNavigate();
  const { t } = useTranslation(["email"] as const);
  const { loaded, threads } = useEmail();
  const seenRef = useRef<Map<string, SeenThread> | undefined>(undefined);

  useEffect(() => {
    if (!loaded) return;
    const initialized = seenRef.current !== undefined;
    const arrived = newEtaMailThreads(
      seenRef.current ?? new Map(),
      threads,
      initialized,
    );
    seenRef.current = new Map(
      threads.map((thread) => [
        thread.id,
        {
          lastMessageAt: thread.lastMessageAt,
          incomingCount: thread.incomingCount,
        },
      ]),
    );
    for (const thread of arrived) {
      toast(t("notification.received"), {
        id: `eta-mail-${thread.id}`,
        description: t("notification.description", {
          peer: thread.peer,
          subject: thread.subject,
        }),
        duration: 8_000,
        icon: createElement(EnvelopeSimpleIcon, { "aria-hidden": true }),
        action: {
          label: t("notification.open"),
          onClick: () =>
            void navigate({ to: "/email", search: { thread: thread.id } }),
        },
      });
    }
  }, [loaded, navigate, t, threads]);
}
