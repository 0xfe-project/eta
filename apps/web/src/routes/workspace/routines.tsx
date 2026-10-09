import { createFileRoute } from "@tanstack/react-router";
import { validateRoutineSearch } from "@/components/workspace/routine-nav";
import { RoutinesPage } from "@/pages/routines";

export const Route = createFileRoute("/workspace/routines")({
  validateSearch: validateRoutineSearch,
  component: RoutinesPage,
});
