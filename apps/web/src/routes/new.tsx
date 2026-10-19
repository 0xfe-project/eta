import { createFileRoute } from "@tanstack/react-router";
import { NewSessionPage } from "@/pages/new-session";

export const Route = createFileRoute("/new")({
  // The project can arrive in the URL: the sidebar's per-project "+" starts a conversation in that
  // project rather than making you pick it again.
  validateSearch: (search: Record<string, unknown>) => ({
    project: typeof search.project === "string" ? search.project : undefined,
  }),
  component: NewSessionPage,
});
