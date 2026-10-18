import type { ProjectView } from "@eta/client-contracts";
import { FolderSimpleIcon } from "@phosphor-icons/react/FolderSimple";
import { useTranslation } from "react-i18next";
import { folderName } from "@/lib/projects";
import { cn } from "@/lib/utils";

/**
 * Which project this conversation works in, in the header.
 *
 * The path is the fact; the name is what fits. So the chip shows the project's name and keeps the
 * whole path in `title` and in the accessible name — a truncated path with nothing behind it is a
 * path nobody can act on.
 */
export function ProjectChip({
  project,
  className,
}: {
  project: ProjectView | undefined;
  className?: string;
}) {
  const { t: translateText } = useTranslation("chat");
  if (project === undefined) return null;
  return (
    <span
      className={cn(
        "inline-flex min-w-0 max-w-40 items-center gap-1 border border-border px-1.5 py-0.5 text-xs text-muted-foreground",
        className,
      )}
      title={project.path}
      aria-label={translateText("groups.header.cwdBound", {
        path: project.path,
      })}
    >
      <FolderSimpleIcon aria-hidden="true" className="size-3 shrink-0" />
      <span className="min-w-0 truncate font-mono">
        {project.name || folderName(project.path)}
      </span>
    </span>
  );
}
