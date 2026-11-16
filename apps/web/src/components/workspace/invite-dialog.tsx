import type { AgentView } from "@eta/client-contracts";
import type { KeyboardEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Empty } from "@/components/states";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useConversationActions } from "@/queries/conversations";
import { wireErrorMessage } from "@/queries/wire";
import { AGENT_SEARCH_FROM } from "./agent-pick";
import { AgentPickRow } from "./agent-pick-row";
import { moveRow } from "./use-directory-browser";

type Candidate = Pick<AgentView, "id" | "name" | "runtime">;

/**
 * Inviting agents into a group: tick as many as wanted, then one invite for all of them. The list
 * is the agents not in it yet; with many, a search narrows it by name.
 */
export function InviteDialog({
  open,
  onOpenChange,
  conversationId,
  candidates,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversationId: string;
  candidates: readonly Candidate[];
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Mounted per open: what was ticked last time is not what the next open should show. */}
      {open ? (
        <InviteForm
          conversationId={conversationId}
          candidates={candidates}
          onDone={() => onOpenChange(false)}
        />
      ) : null}
    </Dialog>
  );
}

function InviteForm({
  conversationId,
  candidates,
  onDone,
}: {
  conversationId: string;
  candidates: readonly Candidate[];
  onDone: () => void;
}) {
  const { t: translateText } = useTranslation(["chat", "common"] as const);
  const { invite } = useConversationActions();
  const [picked, setPicked] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const listRef = useRef<HTMLUListElement>(null);
  // Without a search the keyboard starts on the first row, so Space ticks it straight away.
  const searchable = candidates.length > AGENT_SEARCH_FROM;
  useEffect(() => {
    if (!searchable)
      listRef.current
        ?.querySelector<HTMLElement>("button")
        ?.focus({ preventScroll: true });
  }, [searchable]);

  const needle = search.trim().toLowerCase();
  const listed = candidates.filter((agent) =>
    agent.name.toLowerCase().includes(needle),
  );
  // One that left the list while ticked (deleted, or invited from elsewhere) is not sent.
  const chosen = picked.filter((id) => candidates.some((a) => a.id === id));
  const toggle = (id: string) =>
    setPicked((now) =>
      now.includes(id) ? now.filter((other) => other !== id) : [...now, id],
    );
  const submit = () => {
    if (chosen.length === 0 || invite.isPending) return;
    // A failure keeps the dialog and what was ticked, and says why.
    invite.mutate(
      { conversationId, agentIds: chosen },
      {
        onSuccess: onDone,
        onError: (error) => toast.error(wireErrorMessage(error)),
      },
    );
  };
  // Enter sends from the search or a row; a button of the footer keeps its own press.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    const target = event.target as HTMLElement;
    if (
      target.tagName === "BUTTON" &&
      target.getAttribute("role") !== "checkbox"
    )
      return;
    event.preventDefault();
    submit();
  };

  return (
    <DialogContent onKeyDown={onKeyDown}>
      <DialogHeader>
        <DialogTitle>{translateText("groups.members.inviteTitle")}</DialogTitle>
        <DialogDescription>
          {translateText("groups.members.inviteDescription")}
        </DialogDescription>
      </DialogHeader>
      {searchable ? (
        <Input
          autoFocus
          aria-label={translateText("groups.members.inviteSearch")}
          placeholder={translateText("groups.members.inviteSearch")}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => moveRow(event, listRef.current)}
          className="h-7 pointer-coarse:h-9"
        />
      ) : null}
      {listed.length === 0 ? (
        <div className="grid min-h-24 place-content-center">
          <Empty
            title={translateText(
              candidates.length === 0
                ? "groups.members.inviteNone"
                : "groups.members.inviteNoMatch",
            )}
          />
        </div>
      ) : (
        <ul
          ref={listRef}
          onKeyDown={(event) => moveRow(event, listRef.current)}
          className="-mx-2 max-h-80 overflow-y-auto"
        >
          {listed.map((agent) => (
            <AgentPickRow
              key={agent.id}
              agent={agent}
              checked={chosen.includes(agent.id)}
              onToggle={() => toggle(agent.id)}
            />
          ))}
        </ul>
      )}
      <DialogFooter className="items-center sm:justify-between">
        <span className="text-xs text-muted-foreground tabular-nums">
          {chosen.length === 0 ? (
            translateText("groups.members.inviteNoneSelected")
          ) : (
            <>
              {translateText("groups.members.invitePicked", {
                count: chosen.length,
              })}
              {" · "}
              <button
                type="button"
                className="underline underline-offset-2 hover:text-foreground"
                onClick={() => setPicked([])}
              >
                {translateText("groups.members.inviteClear")}
              </button>
            </>
          )}
        </span>
        <div className="flex gap-2">
          <Button variant="outline" onClick={onDone}>
            {translateText("common:actions.cancel")}
          </Button>
          <Button
            disabled={chosen.length === 0 || invite.isPending}
            onClick={submit}
          >
            {translateText("groups.members.inviteSubmit", {
              count: chosen.length,
            })}
          </Button>
        </div>
      </DialogFooter>
    </DialogContent>
  );
}
