import { createFileRoute } from "@tanstack/react-router";

// The build this server runs; open tabs compare it with theirs (lib/update.ts).
export const Route = createFileRoute("/version")({
  server: {
    handlers: {
      GET: () =>
        new Response(__AXP_BUILD__, {
          headers: { "Cache-Control": "no-store" },
        }),
    },
  },
});
