import { createFileRoute } from "@tanstack/react-router";
import { receiveBrowserLogs } from "@/server/browser-logs";

// Browser log intake (see lib/report.ts). Outside /api, which the gateway
// sends to the control plane.
export const Route = createFileRoute("/telemetry/logs")({
  server: { handlers: { POST: ({ request }) => receiveBrowserLogs(request) } },
});
