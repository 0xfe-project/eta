import { useTarget } from "@/queries/wire";

/** A persona card a project offers its agents, as the host summarises it. */
export interface PersonaCard {
  id: string;
  name: string;
  description: string;
  custom: boolean;
}

const NONE: PersonaCard[] = [];

/** The cards the host has (the `personas` target's `cards` section). */
export function usePersonas(): PersonaCard[] {
  const cards = useTarget("personas")?.sections.cards as
    | PersonaCard[]
    | undefined;
  return cards ?? NONE;
}
