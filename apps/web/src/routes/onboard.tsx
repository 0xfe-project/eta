import { createFileRoute } from "@tanstack/react-router";
import { Onboard } from "@/pages/onboard";

export const Route = createFileRoute("/onboard")({
  component: Onboard,
});
