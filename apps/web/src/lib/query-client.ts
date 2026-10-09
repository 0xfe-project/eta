import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "./api";

// Called once per router: server requests must never share a query cache.
export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        // Once more, unless the request itself was wrong (a 404 stays one).
        retry: (failures, error) =>
          failures < 1 && !(error instanceof ApiError && error.status < 500),
      },
      mutations: { retry: false },
    },
  });
}

export interface RouterContext {
  queryClient: QueryClient;
}
