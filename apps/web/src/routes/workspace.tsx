import { createFileRoute } from "@tanstack/react-router";
import { AppLayout } from "@/pages/app-layout";

export const Route = createFileRoute("/workspace")({
  // Live data and local drafts load in the browser.
  ssr: false,
  component: AppLayout,
});
