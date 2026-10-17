import type { Group } from "@/queries/chat";
import { FolderSimpleIcon } from "@phosphor-icons/react/FolderSimple";
import { useTranslation } from "react-i18next";
import { folderName, groupCwd } from "@/lib/group-cwd";
import { cn } from "@/lib/utils";

/**
 * Which folder this conversation works in, in the header.
 *
 * The path is the fact; the name is what fits. So the chip shows the last segment and keeps the
 * whole path in `title` and in the accessible name — a truncated path with nothing behind it is a
 * path nobody can act on.
 *
 * An unbound group says so instead of showing nothing: "no folder" is a state with consequences
 * (the members run wherever the host started, notes are read from there), and an empty space in
 * the header would read as "this has no bearing on what I am looking at".
 */
export function CwdChip({
  group,
  className,
}: {
  group: Group | undefined;
  className?: string;
}) {
  const { t: translateText } = useTranslation("chat");
  const cwd = group === undefined ? "" : groupCwd(group);
  if (group === undefined) return null;
  const bound = cwd.length > 0;
  return (
    <span
      className={cn(
        "inline-flex min-w-0 max-w-40 items-center gap-1 border px-1.5 py-0.5 text-xs",
        bound
          ? "border-border text-muted-foreground"
          : "border-dashed border-border-strong text-faint",
        className,
      )}
      title={bound ? cwd : translateText("groups.fields.cwdHelp")}
      aria-label={
        bound
          ? translateText("groups.header.cwdBound", { path: cwd })
          : translateText("groups.header.cwdUnbound")
      }
    >
      <FolderSimpleIcon aria-hidden="true" className="size-3 shrink-0" />
      <span className="min-w-0 truncate font-mono">
        {bound ? folderName(cwd) : translateText("groups.header.cwdUnbound")}
      </span>
    </span>
  );
}
