/**
 * System prompt assembly (verbatim port of eta-agent's `harness/composer.ts`).
 *
 * One string per generation, composed in a fixed order, and the order is the
 * point:
 *
 *   base → persona → skills → platform   (stable: a provider cache keeps these)
 *   goal → tasks → memory                (adaptive: rewritten every generation)
 *
 * Providers cache a prompt *prefix*, so anything the cache is meant to keep must
 * come first and must not change between turns. Persona and the skills catalog
 * describe the session; the goal, the task list and what the agent remembers
 * change as work happens. Putting the volatile part first would invalidate the
 * cache on every turn and quietly spend the user's tokens.
 *
 * The sections are named so a UI can show them (`etaPromptSectionsDetailed`) and
 * measured so a panel can say what the split costs (`etaPromptBlockChars`).
 */
import type { Task } from "@eta/core";
import { goalPursuitGuidelines } from "./goal";
import { renderCurrentTasks, TASK_REVIEW_PROMPT } from "./tasks";

export interface EtaPromptState {
  goal?: { objective: string; status: string } | undefined;
  tasks?: Task[] | undefined;
  /** Rendered persona block (stable card text); right after the base prompt. */
  persona?: string | undefined;
  /** Rendered `<skills>` catalog block; stable, after the persona. */
  skills?: string | undefined;
  /**
   * The platform section: everything the deployment adds beyond the base and the
   * persona — who the agent is here (`<agent>`), where the app's files live
   * (`<platform>`). Stable, after skills.
   */
  platform?: string | undefined;
  /** Rendered `<memory>` block; always last, it changes most often. */
  memory?: string | undefined;
}

/** One section of the prompt pipeline: order and stable/adaptive defined once. */
export interface EtaPromptSection {
  name:
    | "base"
    | "persona"
    | "skills"
    | "platform"
    | "goal"
    | "tasks"
    | "memory";
  stable: boolean;
  text: string;
}

function sections(base: string, state: EtaPromptState): EtaPromptSection[] {
  const out: EtaPromptSection[] = [{ name: "base", text: base, stable: true }];
  if (state.persona !== undefined && state.persona.length > 0) {
    out.push({ name: "persona", text: state.persona, stable: true });
  }
  if (state.skills !== undefined && state.skills.length > 0) {
    out.push({ name: "skills", text: state.skills, stable: true });
  }
  // The platform section describes the deployment (the agent, the app), not the
  // conversation, so it sits with the blocks a provider cache is meant to keep.
  if (state.platform !== undefined && state.platform.length > 0) {
    out.push({ name: "platform", text: state.platform, stable: true });
  }
  if (state.goal !== undefined && state.goal.status === "active") {
    out.push({
      name: "goal",
      text: goalPursuitGuidelines(state.goal.objective),
      stable: false,
    });
  }
  if (state.tasks !== undefined && state.tasks.length > 0) {
    out.push({
      name: "tasks",
      text: `${TASK_REVIEW_PROMPT}\n\n${renderCurrentTasks(state.tasks)}`,
      stable: false,
    });
  }
  if (state.memory !== undefined && state.memory.length > 0) {
    out.push({ name: "memory", text: state.memory, stable: false });
  }
  return out.filter((section) => section.text.length > 0);
}

/** The live prompt as named blocks, for a UI's prompt panel. */
export function etaPromptSectionsDetailed(
  base: string,
  state: EtaPromptState,
): EtaPromptSection[] {
  return sections(base, state);
}

/** The split a cache thinks in: what stays across turns, and what does not. */
export function splitEtaPromptSections(
  base: string,
  state: EtaPromptState,
): { stable: string[]; adaptive: string[] } {
  const all = sections(base, state);
  return {
    stable: all
      .filter((section) => section.stable)
      .map((section) => section.text),
    adaptive: all
      .filter((section) => !section.stable)
      .map((section) => section.text),
  };
}

/** How much of the prompt is cacheable, and how much is rewritten. */
export function etaPromptBlockChars(
  base: string,
  state: EtaPromptState,
): { stableChars: number; adaptiveChars: number } {
  const { stable, adaptive } = splitEtaPromptSections(base, state);
  const chars = (parts: string[]): number =>
    parts.reduce((sum, part) => sum + part.length, 0);
  return { stableChars: chars(stable), adaptiveChars: chars(adaptive) };
}

/** The sections that follow the base prompt, in stable order. */
export function etaPromptSections(state: EtaPromptState): string[] {
  return sections("", state).map((section) => section.text);
}

/** The composed prompt, ready for the runner's `systemPrompt`. */
export function composeEtaSystemPrompt(
  base: string,
  state: EtaPromptState,
): string {
  return sections(base, state)
    .map((section) => section.text)
    .join("\n\n");
}
