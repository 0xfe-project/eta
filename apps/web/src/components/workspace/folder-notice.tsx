import type { Group } from "@/queries/chat";
import { FolderSimpleIcon } from "@phosphor-icons/react/FolderSimple";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { groupCwd } from "@/lib/group-cwd";
import { useGroupActions } from "@/queries/groups";

/**
 * "This group has no folder yet" — and the way to give it one.
 *
 * Shown in a group whose `cwd` is empty: one created before the field existed, or one made
 * without a project in mind. It sits where the composer is, not in a settings page, because the
 * consequence is immediate — the agents are running somewhere nobody chose, and the project's
 * notes are being read from there. Saying it once in a dialog nobody opens would be the same as
 * not saying it.
 *
 * The fix writes the folder through the same PATCH the group editor uses, so there is one path
 * that sets a folder and one place it is validated.
 */
export function UnboundFolderNotice({ group }: { group: Group | undefined }) {
  const { t: translateText } = useTranslation("chat");
  const { update } = useGroupActions();
  const [cwd, setCwd] = useState("");
  if (group === undefined || groupCwd(group).length > 0) return null;

  const save = () => {
    const value = cwd.trim();
    if (value.length === 0) return;
    update.mutate(
      { id: group.id, cwd: value },
      {
        onSuccess: () => setCwd(""),
        onError: (error: Error) => toast.error(error.message),
      },
    );
  };

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-2 border border-dashed border-border-strong px-2 py-1.5 text-xs"
    >
      <FolderSimpleIcon aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">
        {translateText("groups.header.unboundNotice")}
      </span>
      <Input
        value={cwd}
        onChange={(event) => setCwd(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          save();
        }}
        placeholder={translateText("groups.fields.cwdPlaceholder")}
        aria-label={translateText("groups.fields.cwd")}
        spellCheck={false}
        className="h-6 w-52 font-mono text-xs"
      />
      <Button
        size="xs"
        variant="outline"
        onClick={save}
        disabled={update.isPending || cwd.trim().length === 0}
      >
        {translateText("groups.header.bindFolder")}
      </Button>
    </div>
  );
}
