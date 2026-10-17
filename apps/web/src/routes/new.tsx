import { createFileRoute } from "@tanstack/react-router";
import { NewSessionPage } from "@/pages/new-session";

export const Route = createFileRoute("/new")({
  // The folder can arrive in the URL: the sidebar's per-folder "+" starts a conversation in that
  // folder rather than making you type the path again.
  validateSearch: (search: Record<string, unknown>) => ({
    cwd: typeof search.cwd === "string" ? search.cwd : undefined,
  }),
  component: NewSessionPage,
});
