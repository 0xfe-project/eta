import { createFileRoute } from "@tanstack/react-router";
import { NewSessionPage } from "@/pages/new-session";

export const Route = createFileRoute("/new")({
  component: NewSessionPage,
});
