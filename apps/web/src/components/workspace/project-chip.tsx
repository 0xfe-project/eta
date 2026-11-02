import type { ProjectView } from "@eta/client-contracts";
import { FolderSimpleIcon } from "@phosphor-icons/react/FolderSimple";
import { useTranslation } from "react-i18next";
import { folderName, projectPlace } from "@/lib/projects";
import { cn } from "@/lib/utils";
import { useMachines } from "@/queries/projects";

/**
 * Which project this conversation works in, in the header.
 *
 * The path is the fact; the name is what fits. So the chip shows the project's name and keeps the
 * whole path in `title` and in the accessible name — a truncated path with nothing behind it is a
 * path nobody can act on. The whole path includes the machine when it is not the primary: the
 * same path on two machines is two projects.
 */
export function ProjectChip({
  project,
  className,
}: {
  project: ProjectView | undefined;
  className?: string;
}) {
  const { t: translateText } = useTranslation("chat");
  const { machines } = useMachines();
  if (project === undefined) return null;
  const place = projectPlace(project, machines);
  return (
    <span
      className={cn(
        "inline-flex min-w-0 max-w-40 items-center gap-1 border border-border px-1.5 py-0.5 text-xs text-muted-foreground",
        className,
      )}
      title={place}
      aria-label={translateText("groups.header.cwdBound", { path: place })}
    >
      <FolderSimpleIcon aria-hidden="true" className="size-3 shrink-0" />
      <span className="min-w-0 truncate font-mono">
        {project.name || folderName(project.path)}
      </span>
    </span>
  );
}
