import { createFileRoute } from "@tanstack/react-router";
import { RuntimesPage } from "@/pages/runtimes";

export const Route = createFileRoute("/_app/runtimes")({
  component: RuntimesPage,
});
