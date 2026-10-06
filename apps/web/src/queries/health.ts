import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";

const healthSchema = z.object({
  status: z.literal("ok"),
  service: z.literal("control-plane"),
});

// Browser-only query: /api is proxied by Vite in development.
// For SSR loaders, use an absolute server URL or a Start server function.
export function healthQueryOptions() {
  return queryOptions({
    queryKey: ["control-plane", "health"],
    queryFn: async ({ signal }) => {
      const response = await fetch("/api/health", { signal });
      if (!response.ok)
        throw new Error(`Health check failed (${response.status})`);
      return healthSchema.parse(await response.json());
    },
  });
}
