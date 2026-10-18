import { useQuery } from "@tanstack/react-query";

interface PersonaOption {
  id: string;
  name: string;
  description: string;
  custom?: boolean;
}

/** The cards a project offers its agents, read from the host's own persona store. */
export function usePersonas() {
  return useQuery({
    queryKey: ["personas"],
    staleTime: 30_000,
    queryFn: async () => {
      const response = await fetch("/api/v1/personas");
      if (!response.ok) return [] as PersonaOption[];
      // The host answers an envelope (`{ personas: [...] }`), not a bare array: a list route
      // that grows a field later should not have to change its shape.
      const body = (await response.json()) as { personas?: PersonaOption[] };
      return body.personas ?? [];
    },
  });
}
