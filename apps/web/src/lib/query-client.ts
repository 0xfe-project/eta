import { QueryClient } from "@tanstack/react-query";

// Called once per router instance so tests and the app do not share a cache.
export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: 1,
      },
      mutations: { retry: false },
    },
  });
}

export interface RouterContext {
  queryClient: QueryClient;
}
