import type { DirectoryProblem } from "@eta/client-contracts";
import type { KeyboardEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { WireError } from "@/lib/wire";
import { directoriesQuery, useMachines } from "@/queries/projects";

/** What a caller is told when a listing failed; a failure without a code is nobody answering. */
function problemOf(error: unknown): DirectoryProblem {
  const code = error instanceof WireError ? error.problem?.code : undefined;
  return code === "not_found" || code === "denied" ? code : "offline";
}

/** Up and down walk the buttons of a list; a filter box hands over to the first one. */
export function moveRow(event: KeyboardEvent, list: HTMLElement | null) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const rows = [...(list?.querySelectorAll<HTMLElement>("button") ?? [])];
  const at = rows.indexOf(document.activeElement as HTMLElement);
  const next = rows[event.key === "ArrowDown" ? at + 1 : Math.max(at - 1, 0)];
  if (next === undefined) return;
  event.preventDefault();
  next.focus();
}

/**
 * Where someone is on the way to a directory. Apart from the picker that draws it, because the
 * dialog around the picker needs it too: leaving for the next step and coming back finds it as it
 * was, and the footer and Escape depend on what it is doing.
 */
export function useDirectoryBrowser(start: {
  /** Undefined is the primary. */
  machineId: string | undefined;
  /** Undefined is the machine's home. */
  path: string | undefined;
}) {
  const client = useQueryClient();
  const { machines } = useMachines();
  const primary = machines.find((machine) => machine.kind === "primary");
  const [place, setPlace] = useState(start);
  const [filter, setFilter] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [typing, setTyping] = useState<
    { value: string; problem?: DirectoryProblem } | undefined
  >(undefined);
  const machineId = place.machineId ?? primary?.id ?? "";
  const listing = useQuery({
    ...directoriesQuery(machineId, place.path),
    enabled: machineId !== "",
  });
  const listRef = useRef<HTMLDivElement>(null);
  // The check of a typed path that is still the one that counts: one left behind says nothing.
  const attemptRef = useRef(0);

  const machine = machines.find((entry) => entry.id === machineId);
  const listed = listing.data;
  const home = listed?.home ?? machine?.home ?? undefined;

  const go = (next: { machineId?: string; path: string | undefined }) => {
    attemptRef.current += 1;
    setPlace((now) => ({ ...now, ...next }));
    setFilter("");
    setTyping(undefined);
    // Whatever was pressed is gone with the list it was in; the keyboard carries on from the new
    // one. A box that holds focus rather than a row, because the rows are not there yet.
    listRef.current?.focus({ preventScroll: true });
  };

  const jump = async () => {
    const value = typing?.value.trim();
    if (value === undefined || value === "") return;
    attemptRef.current += 1;
    const mine = attemptRef.current;
    try {
      const found = await client.fetchQuery(directoriesQuery(machineId, value));
      if (mine !== attemptRef.current) return;
      client.setQueryData(
        directoriesQuery(machineId, found.path).queryKey,
        found,
      );
      go({ path: found.path });
    } catch (error) {
      if (mine !== attemptRef.current) return;
      setTyping({ value, problem: problemOf(error) });
    }
  };

  const closeTyping = () => {
    attemptRef.current += 1;
    setTyping(undefined);
  };

  return {
    machineId,
    listing,
    listed,
    home,
    current: listed?.path ?? place.path ?? home,
    problem: listing.isError ? problemOf(listing.error) : undefined,
    filter,
    setFilter,
    showHidden,
    setShowHidden,
    typing,
    setTyping,
    listRef,
    go,
    jump,
    closeTyping,
  };
}

export type DirectoryBrowser = ReturnType<typeof useDirectoryBrowser>;
