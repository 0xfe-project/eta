/**
 * The subagent planner — turning one big ask into a plan that can actually run.
 *
 * This is new work rather than a port: eta-agent's `harness/subagent.ts` had no
 * planner at all, it spawned a lane and read its last message. What went wrong
 * with that (and with a model handed a single goal) is that "do the migration"
 * becomes one long undifferentiated run: nothing says what the subtasks are,
 * nothing says when one is *done*, and nothing notices that two of them could have
 * gone at the same time.
 *
 * So a plan here is a list of tasks that each carry:
 *
 * - **what to do** (`brief`) and **what would make it done** (`acceptance`) — a
 *   subtask without an acceptance condition cannot be reported on, only "tried";
 * - **what it waits for** (`dependsOn`) — which is what makes the topology usable:
 *   tasks with nothing left to wait for run *together*, tasks behind them run after;
 * - **what came back** (`PlannerReport`: conclusion, evidence, open) — the shape a
 *   parent can read and act on, instead of prose it has to guess at.
 *
 * The other half is that plans are wrong: a tool result contradicts an assumption,
 * a subtask turns out to be three. `replan` takes the reports and a revision and
 * produces a plan that keeps finished work, repairs what it can, and validates the
 * result — a cycle or a dependency on a task that does not exist is refused here
 * rather than discovered by a pool that deadlocks.
 *
 * Nothing in this file runs an agent: `SubagentTaskRunner` is the seam, and the
 * pool (`SubagentManager`) is what the caller supplies behind it.
 */
import type { SubagentRecord } from "./subagent";

/** One subtask: what to do, what "done" means, and what it waits for. */
export interface PlanTask {
  /** Stable id, referenced by other tasks' `dependsOn`. */
  id: string;
  /** One line: what this task is for. */
  title: string;
  /** The instruction the subagent is given. */
  brief: string;
  /** Conditions a reviewer (or the subagent) can check; empty means "not checkable". */
  acceptance: string[];
  /** Ids that must be finished first. */
  dependsOn: string[];
}

/** A plan: the goal it serves, and its tasks. */
export interface Plan {
  goal: string;
  tasks: PlanTask[];
}

/** What a subtask reports: what it concluded, what backs it up, what is unresolved. */
export interface PlannerReport {
  /** The claim, in one or two sentences. */
  conclusion: string;
  /** What supports it: what was read, run, or observed. */
  evidence: string[];
  /** What the subtask could not settle — the part a parent must decide about. */
  open: string[];
}

export type PlanTaskStatus =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "blocked";

/** One task's outcome. `blocked` means a dependency failed; it never ran. */
export interface PlanTaskResult {
  taskId: string;
  status: Exclude<PlanTaskStatus, "pending" | "running">;
  report?: PlannerReport | undefined;
  error?: string | undefined;
}

/** How one subtask runs. The caller supplies the pool. */
export type SubagentTaskRunner = (
  task: PlanTask,
  plan: Plan,
) => Promise<PlannerReport | string>;

/** Where a plan's progress is announced; a host bridges it to whatever it watches. */
export interface PlannerObserver {
  onTaskStart?: ((task: PlanTask, wave: number) => void) | undefined;
  onTaskFinish?: ((result: PlanTaskResult, wave: number) => void) | undefined;
}

/**
 * Check a plan before anything runs on it: unique ids, known dependencies, no
 * cycles. A cycle would otherwise be a pool waiting forever on itself.
 */
export function validatePlan(plan: Plan): void {
  const byId = new Map<string, PlanTask>();
  for (const task of plan.tasks) {
    if (task.id.length === 0) throw new Error("plan task has no id");
    if (byId.has(task.id))
      throw new Error(`duplicate plan task id: ${task.id}`);
    byId.set(task.id, task);
  }
  for (const task of plan.tasks) {
    for (const dependency of task.dependsOn) {
      if (!byId.has(dependency)) {
        throw new Error(
          `plan task ${task.id} depends on unknown task ${dependency}`,
        );
      }
      if (dependency === task.id)
        throw new Error(`plan task ${task.id} depends on itself`);
    }
  }
  // Kahn's algorithm: whatever is left when nothing more can be placed is a cycle.
  const placed = new Set<string>();
  for (;;) {
    const ready = plan.tasks.filter(
      (task) =>
        !placed.has(task.id) &&
        task.dependsOn.every((dependency) => placed.has(dependency)),
    );
    if (ready.length === 0) break;
    for (const task of ready) placed.add(task.id);
  }
  if (placed.size !== plan.tasks.length) {
    const stuck = plan.tasks
      .filter((task) => !placed.has(task.id))
      .map((task) => task.id);
    throw new Error(`plan has a dependency cycle: ${stuck.join(", ")}`);
  }
}

/**
 * The plan as waves: every task in wave N can run at the same time, and every wave
 * runs after the one before it. This is the whole point of `dependsOn` — a task
 * with no unmet dependency is not delayed by one that has some.
 */
export function planWaves(plan: Plan): string[][] {
  validatePlan(plan);
  const placed = new Set<string>();
  const waves: string[][] = [];
  for (;;) {
    const ready = plan.tasks
      .filter(
        (task) =>
          !placed.has(task.id) &&
          task.dependsOn.every((dependency) => placed.has(dependency)),
      )
      .map((task) => task.id);
    if (ready.length === 0) break;
    waves.push(ready);
    for (const id of ready) placed.add(id);
  }
  return waves;
}

export interface RunPlanOptions {
  run: SubagentTaskRunner;
  observer?: PlannerObserver | undefined;
  /** A task's report as read from the subagent; defaults to parsing its answer. */
  toReport?:
    | ((answer: PlannerReport | string, task: PlanTask) => PlannerReport)
    | undefined;
}

/**
 * Run a plan wave by wave.
 *
 * Inside a wave everything starts together (that is what "no dependencies left"
 * means), and between waves everything waits — including for the *task-level*
 * decision that matters: if a task fails, the tasks behind it are reported as
 * `blocked` instead of running against an assumption that did not hold.
 */
export async function runPlan(
  plan: Plan,
  options: RunPlanOptions,
): Promise<PlanTaskResult[]> {
  const waves = planWaves(plan);
  const results = new Map<string, PlanTaskResult>();
  const byId = new Map(plan.tasks.map((task) => [task.id, task]));
  const readReport =
    options.toReport ?? ((answer: PlannerReport | string) => asReport(answer));

  for (const [wave, ids] of waves.entries()) {
    const runnable: PlanTask[] = [];
    for (const id of ids) {
      const task = byId.get(id)!;
      const failed = task.dependsOn.find(
        (dependency) => results.get(dependency)?.status !== "done",
      );
      if (failed !== undefined) {
        // The work behind a failure is not attempted: a subtask told to build on
        // something that did not happen reports a failure of its own, and the
        // parent cannot tell the two apart afterwards.
        const result: PlanTaskResult = {
          taskId: id,
          status: "blocked",
          error: `blocked by ${failed}`,
        };
        results.set(id, result);
        options.observer?.onTaskFinish?.(result, wave);
        continue;
      }
      runnable.push(task);
    }

    await Promise.all(
      runnable.map(async (task) => {
        options.observer?.onTaskStart?.(task, wave);
        let result: PlanTaskResult;
        try {
          const answer = await options.run(task, plan);
          result = {
            taskId: task.id,
            status: "done",
            report: readReport(answer, task),
          };
        } catch (error) {
          result = {
            taskId: task.id,
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
          };
        }
        results.set(task.id, result);
        options.observer?.onTaskFinish?.(result, wave);
      }),
    );
  }
  // Callers read results in plan order, not completion order.
  return plan.tasks.map(
    (task) =>
      results.get(task.id) ?? {
        taskId: task.id,
        status: "failed",
        error: "the task was never run",
      },
  );
}

/** What the planner is asked, as a system prompt: the plan format, spelled out. */
export const PLANNER_PROMPT = [
  "You plan work before it runs. Answer with one fenced json block and nothing else:",
  '{"tasks":[{"id":"t1","title":"…","brief":"…","acceptance":["…"],"dependsOn":[]}]}',
  "Rules:",
  "- one task per independently checkable piece of work;",
  "- every task needs at least one acceptance condition, phrased so someone else could check it;",
  "- dependsOn lists ids that must finish first; leave it empty when nothing has to;",
  "- tasks with no dependencies on each other run at the same time, so do not invent an order you do not need;",
  "- ids are stable and lowercase.",
].join("\n");

/** What a subtask is told to answer with, as part of its brief. */
export const TASK_REPORT_PROMPT = [
  "When you are done, answer with one fenced json block and nothing else:",
  '{"conclusion":"…","evidence":["…"],"open":["…"]}',
  "- conclusion: what you found, in one or two sentences;",
  "- evidence: what you read, ran, or observed that supports it;",
  "- open: what you could not settle (an empty list is a fine answer).",
].join("\n");

/** The json block a model was asked for, or `undefined` when there is none. */
export function extractJsonBlock(text: string): unknown {
  // eslint-disable-next-line regexp/no-super-linear-backtracking -- a model reply; a rewrite could change what matches
  const match = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = match?.[1] ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/**
 * Read a plan out of a model's answer, or say what is wrong with it.
 *
 * Everything is normalised (a single condition may come as a string, a dependency
 * list may be absent) so a model that is *nearly* right still produces a usable
 * plan — and what cannot be normalised is refused, because a plan that is silently
 * missing a dependency runs work out of order.
 */
export function parsePlan(text: string, goal = ""): Plan {
  const parsed = extractJsonBlock(text) as { tasks?: unknown } | undefined;
  const raw = parsed?.tasks;
  if (!Array.isArray(raw) || raw.length === 0)
    throw new Error("the planner answered without any tasks");
  const tasks: PlanTask[] = raw.map((entry, index) => {
    const task = entry as Record<string, unknown>;
    const id =
      typeof task.id === "string" && task.id.length > 0
        ? task.id
        : `t${index + 1}`;
    const brief = typeof task.brief === "string" ? task.brief : "";
    const title =
      typeof task.title === "string" && task.title.length > 0
        ? task.title
        : brief.slice(0, 60);
    if (brief.length === 0) throw new Error(`plan task ${id} has no brief`);
    return {
      id,
      title,
      brief,
      acceptance: stringList(task.acceptance),
      dependsOn: stringList(task.dependsOn),
    };
  });
  const plan: Plan = { goal, tasks };
  validatePlan(plan);
  return plan;
}

/** Read a subtask's report. A model that answered in prose still reports its prose. */
export function parseReport(text: string): PlannerReport {
  const parsed = extractJsonBlock(text) as Record<string, unknown> | undefined;
  if (parsed === undefined || typeof parsed.conclusion !== "string") {
    return { conclusion: text.trim(), evidence: [], open: [] };
  }
  return {
    conclusion: parsed.conclusion,
    evidence: stringList(parsed.evidence),
    open: stringList(parsed.open),
  };
}

/** A report, from whatever the runner handed back. */
export function asReport(answer: PlannerReport | string): PlannerReport {
  return typeof answer === "string" ? parseReport(answer) : answer;
}

export interface ReplanOptions {
  /** The plan as it stood, with the statuses the run reported. */
  plan: Plan;
  results: readonly PlanTaskResult[];
  /**
   * The revision: tasks to add or replace, by id. A task already `done` is kept as
   * it was — replanning is about what is left, and re-running finished work is how
   * a plan turns into a loop.
   */
  revision: PlanTask[];
  /** Tasks the revision says are no longer needed. */
  dropped?: readonly string[] | undefined;
}

/**
 * Fold a revision into a plan that has partly run.
 *
 * This is the part that makes a plan usable under contact with reality: a tool
 * result contradicts an assumption, so a task is replaced; a subtask turns out to
 * be three, so they are added and wired to what is left. What is *not* allowed is
 * a revision that invalidates finished work (refused, with the reason) or one that
 * breaks the topology (refused by the same validation every plan goes through).
 */
export function replan(options: ReplanOptions): Plan {
  const done = new Map(
    options.results
      .filter((result) => result.status === "done")
      .map((result) => [result.taskId, result]),
  );
  const dropped = new Set(options.dropped ?? []);
  for (const task of options.revision) {
    if (done.has(task.id)) {
      throw new Error(
        `replan would replace finished task ${task.id}; keep it and add a new one instead`,
      );
    }
  }
  const revisions = new Map(options.revision.map((task) => [task.id, task]));
  const kept: PlanTask[] = [];
  for (const task of options.plan.tasks) {
    if (dropped.has(task.id)) {
      if (done.has(task.id))
        throw new Error(`replan would drop finished task ${task.id}`);
      continue;
    }
    kept.push(revisions.get(task.id) ?? task);
  }
  for (const task of options.revision) {
    if (!options.plan.tasks.some((existing) => existing.id === task.id))
      kept.push(task);
  }
  const plan: Plan = { goal: options.plan.goal, tasks: kept };
  validatePlan(plan);
  return plan;
}

/** The prompt one task asks its subagent with: the brief, its conditions, its format. */
export function taskPrompt(task: PlanTask, plan: Plan): string {
  const parts = [
    plan.goal.length === 0 ? "" : `Overall goal: ${plan.goal}`,
    task.brief,
  ];
  if (task.acceptance.length > 0) {
    parts.push(
      [
        "Done means:",
        ...task.acceptance.map((condition) => `- ${condition}`),
      ].join("\n"),
    );
  }
  parts.push(TASK_REPORT_PROMPT);
  return parts.filter((part) => part.length > 0).join("\n\n");
}

/** A child's spec for a plan task: the prompt above, and its own turn budget. */
export function taskSpec(
  task: PlanTask,
  plan: Plan,
  options: { model?: string; maxTurns?: number } = {},
) {
  return {
    prompt: taskPrompt(task, plan),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns }),
  };
}

/** A task's status after a run, for whoever draws the plan. */
export function statusesOf(
  results: readonly PlanTaskResult[],
): Map<string, PlanTaskStatus> {
  return new Map(results.map((result) => [result.taskId, result.status]));
}

/** The record a task's child produced, for callers that keep the pool alongside. */
export type PlanTaskRecord = SubagentRecord;

function stringList(value: unknown): string[] {
  if (typeof value === "string") return value.length === 0 ? [] : [value];
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  );
}
