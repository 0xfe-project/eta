import type { ProjectView } from "@eta/client-contracts";
import { useProjects } from "@/queries/projects";

/** The projects a conversation can be started in: not an agent's own workspace, not put away. */
export function useChoosable(): ProjectView[] {
  const { projects } = useProjects();
  return projects.filter(
    (project) => project.kind === "project" && !project.archived,
  );
}
