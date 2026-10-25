import { createFileRoute, redirect } from "@tanstack/react-router";
import { validateRoutineSearch } from "@/components/workspace/routine-nav";
import { ROUTINES_VISIBLE } from "@/lib/features";
import { RoutinesPage } from "@/pages/routines";

export const Route = createFileRoute("/_app/routines")({
  validateSearch: validateRoutineSearch,
  // 定时 is not offered in this build: the page is not served, and an old link lands on the
  // conversation list like any other path that is not a page.
  beforeLoad: () => {
    if (!ROUTINES_VISIBLE)
      throw redirect({ to: "/", search: {}, replace: true });
  },
  component: RoutinesPage,
});
