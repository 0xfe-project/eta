/** Persona vocabulary: an identity card the kernel renders into the prompt. */
export interface PersonaCard {
  id: string;
  name: string;
  /** The body text injected into the system prompt. */
  content: string;
  /** Free-form flags plugins and the host can hang on a card. */
  badges?: string[];
}
