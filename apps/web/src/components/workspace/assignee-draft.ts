import type { AssigneeInput, Place, Places, Task } from "@/queries/tasks";
import { usePlaces } from "@/queries/tasks";
import { assigneeFromKey, assigneeKey } from "./task-format";

// The assignee being picked: who a task is for and, for a remote agent,
// where it works.

export interface AssigneeDraft {
  /** assigneeKey(): none, user or remote:<computer>:<runtime>:<provider>. */
  key: string;
  /** workspace:<id>:<session> or worktree:<from>:<session>. */
  place: string;
  branch: string;
  base: string;
}

export const emptyDraft: AssigneeDraft = {
  key: "none",
  place: "",
  branch: "",
  base: "",
};

export const placeKey = (kind: string, id: string, session?: string | null) =>
  `${kind}\u0000${id}\u0000${session ?? ""}`;

export function draftOf(assignee: Task["assignee"]): AssigneeDraft {
  const place = assignee.place;
  return {
    key: assigneeKey(assignee),
    place: place
      ? placeKey(
          place.kind,
          (place.kind === "worktree" ? place.from : place.workspace_id) ?? "",
          place.session,
        )
      : "",
    branch: place?.branch ?? "",
    base: place?.base ?? "",
  };
}

/** The draft as the API's assignee, or null while a remote place is unset. */
export function draftInput(
  draft: AssigneeDraft,
  places: Places | undefined,
): AssigneeInput | null {
  const assignee = assigneeFromKey(draft.key);
  if (assignee.kind !== "remote") return assignee;
  if (!draft.place) return null;
  const [kind, id, session] = draft.place.split("\u0000");
  const name =
    kind === "worktree"
      ? places?.projects.find((p) => p.id === id)?.name
      : places?.workspaces.find((w) => w.id === id)?.name;
  const place: Place =
    kind === "worktree"
      ? {
          kind: "worktree",
          from: id,
          branch: draft.branch.trim() || null,
          base: draft.base.trim() || null,
        }
      : { kind: "workspace", workspace_id: id };
  if (session) place.session = session;
  if (name) place.name = name;
  return { ...assignee, place };
}

/** The places for a draft's remote assignee, for draftInput. */
export function useDraftPlaces(draft: AssigneeDraft) {
  const assignee = assigneeFromKey(draft.key);
  const remote = assignee.kind === "remote";
  return usePlaces(
    remote ? (assignee.computer_id ?? null) : null,
    remote ? (assignee.runtime ?? null) : null,
  ).data;
}
