import { createFileRoute } from "@tanstack/react-router";
import { validateTaskSearch } from "@/components/workspace/task-nav";
import { TasksPage } from "@/pages/tasks";

export const Route = createFileRoute("/_app/tasks")({
  validateSearch: validateTaskSearch,
  component: TasksPage,
});
