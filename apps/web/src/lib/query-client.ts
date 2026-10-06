import { QueryClient } from "@tanstack/react-query";

// Called once per router: server requests must never share a query cache.
export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 30_000, retry: 1 },
      mutations: { retry: false },
    },
  });
}

export interface RouterContext {
  queryClient: QueryClient;
}
