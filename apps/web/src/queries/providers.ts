import { useQuery } from "@tanstack/react-query";

/** What the editor sees of a provider. The key itself never leaves the host. */
export interface ProviderView {
  id: string;
  name: string;
  kind: string;
  baseUrl: string;
  has_key: boolean;
  headers: Record<string, string | null>;
  models: {
    id: string;
    name: string | null;
    context_window: number | null;
    input: string[];
    reasoning: boolean;
    thinking_mode: string;
    levels: string[];
  }[];
}

export function useProviders() {
  return useQuery({
    queryKey: ["llm", "providers"],
    staleTime: 10_000,
    queryFn: async (): Promise<ProviderView[]> => {
      const response = await fetch("/api/llm/v1/providers");
      if (!response.ok) return [];
      const body = (await response.json()) as { providers?: ProviderView[] };
      return body.providers ?? [];
    },
  });
}
