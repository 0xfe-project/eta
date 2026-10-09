import { createFileRoute } from "@tanstack/react-router";
import { CapabilitiesPage } from "@/pages/capabilities";

export const Route = createFileRoute("/workspace/capabilities")({
  component: CapabilitiesPage,
});
