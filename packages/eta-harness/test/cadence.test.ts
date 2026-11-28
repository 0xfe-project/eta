/**
 * Reminder cadence (REFACTOR.md §2.3.3, ported from eta-agent's
 * harness/cadence.ts).
 *
 * The harness reminder service owns the signal — when a reminder is due — and the prompts
 * plugin owns the text. Transient by design: nothing lands in the transcript.
 */

import type { CadenceConfig, CadenceState } from "../src/reminder/cadence";
import { describe, expect, it } from "vitest";
import {
  createCadenceState,
  DEFAULT_STEP_TOOL_NAMES,
  evaluateToolResult,
  onTurnStart,
} from "../src/reminder/cadence";

const config: CadenceConfig = {
  reminderInterval: 5,
  stepToolNames: DEFAULT_STEP_TOOL_NAMES,
};

function turns(state: CadenceState, n: number): void {
  for (let index = 0; index < n; index += 1) onTurnStart(state);
}

describe("cadence state machine", () => {
  it("becomes due only after the interval and only when there are tasks", () => {
    const state = createCadenceState();
    turns(state, 3);
    expect(evaluateToolResult(state, "read", true, config).markDue).toBe(false);
    turns(state, 2);
    expect(evaluateToolResult(state, "read", true, config).markDue).toBe(true);
    expect(state.reminderDue).toBe(true);
  });

  it("a task-tool call resets the cadence", () => {
    const state = createCadenceState();
    turns(state, 4);
    evaluateToolResult(state, "update_step", true, config);
    turns(state, 4);
    expect(evaluateToolResult(state, "read", true, config).markDue).toBe(false);
    turns(state, 1);
    expect(evaluateToolResult(state, "read", true, config).markDue).toBe(true);
  });
});
