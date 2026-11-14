/**
 * Kernel — one session's runtime floor.
 *
 * A kernel is a cordis Context plus the three privileged primitives, the
 * inject() door, and the turn budget. Primitives are Service subclasses
 * constructed directly: they register through reflect.provide, never enter
 * the plugin registry, so the host cannot unload the floor out from under a
 * running agent (REFACTOR.md §2.1).
 *
 * There is deliberately no loop here, and no SealedFlags: what a subagent
 * must not do is expressed as absence — its kernel simply has no goal set,
 * no continuation driver, and no spawn tool (REFACTOR.md §1.4).
 */

import type { KernelConfig } from "../types/config";
import type { Emit } from "../types/events";
import type { AgentMessage } from "../types/messages";
import type { PersonaCard } from "../types/persona";
import type { StoredTask } from "../types/tasks";
import type { GoalState } from "./goal";
import type { QueuedItem } from "./inbox";
import { Context } from "cordis";
import { defaultKernelConfig } from "../types/config";
import { kernelEmit } from "../types/events";
import { ConfigService } from "./config";
import { GoalService } from "./goal";
import { Inbox } from "./inbox";
import { PersonaService } from "./persona";
import { TaskService } from "./tasks";
import { ToolService } from "./tools";

/**
 * The service names one kernel registers. Two sessions under one root must not
 * collide on them: cordis scopes a provided name to the root unless the context
 * isolates it, and two sessions in one process are two sessions, not two halves
 * of one.
 */
export const KERNEL_SERVICE_NAMES = [
  "config",
  "goal",
  "persona",
  "tasks",
  "tools",
] as const;

/**
 * A context whose session-scoped names do not collide with a sibling's: the same
 * tree, a separate scope for each name. Anything that provides a session-scoped
 * service under a shared root goes through this.
 */
export function sessionScope(
  parent: Context,
  names: readonly string[],
): Context {
  let scope = parent;
  for (const name of names) scope = scope.isolate(name);
  return scope;
}

export interface KernelOptions {
  /** Upper bound on runner turns. `null` (default) runs until the turn loop settles. */
  maxTurns?: number | null;
  /** Parent context (the server's root). Defaults to a fresh root context. */
  /**
   * A parent context to hang this kernel off. Service *names* are scoped to the
   * kernel, so a sibling under the same parent does not collide with it — but
   * cordis dispatches events across the whole tree, so two kernels under one root
   * share a bus. Give each session its own root when their events must not mix
   * (the server does).
   */
  parent?: Context;
  /** Initial configuration; the runner reads it live every turn. */
  config?: Partial<KernelConfig>;
  /** Called when a summarizer throws; the run continues either way. */
  warn?: (message: string) => void;
}

export interface KernelInspect {
  config: KernelConfig;
  maxTurns: number | null;
  turns: number;
  budgetSpent: boolean;
  goal: GoalState | undefined;
  tasks: StoredTask[];
  tools: string[];
  personas: PersonaCard[];
  activePersonaNames: string[];
  inboxDepth: number;
}

export class Kernel {
  readonly ctx: Context;
  readonly goal: GoalService;
  readonly persona: PersonaService;
  readonly tasks: TaskService;
  readonly tools: ToolService;
  readonly config: ConfigService;
  /** How the outside world reaches the loop (steer / followUp / nextRun). */
  readonly inbox = new Inbox();
  readonly maxTurns: number | null;

  private turnCount = 0;
  private readonly emit: Emit;

  private constructor(options: KernelOptions) {
    // A session's services live in their own scope: a second session under the
    // same root would otherwise collide on the first one's names.
    this.ctx =
      options.parent === undefined
        ? new Context()
        : sessionScope(options.parent, KERNEL_SERVICE_NAMES);
    this.maxTurns = options.maxTurns ?? null;
    this.emit = kernelEmit(this.ctx);
    this.goal = new GoalService(this.ctx);
    this.persona = new PersonaService(this.ctx);
    this.tasks = new TaskService(this.ctx);
    this.tools = new ToolService(this.ctx);
    this.config = new ConfigService(
      this.ctx,
      defaultKernelConfig(options.config),
    );
  }

  static create(options: KernelOptions = {}): Kernel {
    return new Kernel(options);
  }

  get turns(): number {
    return this.turnCount;
  }

  /** Whether the turn budget is spent. Always false when `maxTurns` is null. */
  get budgetSpent(): boolean {
    return this.maxTurns !== null && this.turnCount >= this.maxTurns;
  }

  /**
   * Report one finished turn. Returns whether another turn is still allowed,
   * so the runner can ask at the turn boundary and stop on `false`.
   */
  noteTurn(): boolean {
    this.turnCount += 1;
    return !this.budgetSpent;
  }

  /**
   * The one door into the turn loop (REFACTOR.md §2.5). User input, a server-
   * top-level wake, and a child agent's output all arrive here: they queue as
   * steering, so a run in flight changes course at its next boundary instead
   * of being interrupted mid-turn, and an idle kernel starts a run for them.
   */
  inject(message: AgentMessage): QueuedItem {
    const item = this.inbox.enqueue("steer", message);
    this.emit("inject:received", { message: item.message });
    return item;
  }

  /** Queue an input for the next boundary of the run in flight. */
  steer(
    message: string | AgentMessage,
    images?: Parameters<Inbox["enqueue"]>[2],
  ): QueuedItem {
    return this.inbox.enqueue("steer", message, images);
  }

  /** Queue an input for when the run would otherwise stop. */
  followUp(
    message: string | AgentMessage,
    images?: Parameters<Inbox["enqueue"]>[2],
  ): QueuedItem {
    return this.inbox.enqueue("followUp", message, images);
  }

  /** Queue an input for the next run, whenever that is. */
  nextRun(
    message: string | AgentMessage,
    images?: Parameters<Inbox["enqueue"]>[2],
  ): QueuedItem {
    return this.inbox.enqueue("nextRun", message, images);
  }

  /** What a run takes when it starts (the modes come from the live config). */
  acceptInbox(): QueuedItem[] {
    this.inbox.configure({
      steeringMode: this.config.read("steeringMode"),
      followUpMode: this.config.read("followUpMode"),
    });
    return this.inbox.accept();
  }

  /** What a boundary takes: steering, then follow-ups when nothing else continues. */
  takeAtBoundary(options: { followUpWhenNoTrigger: boolean }): {
    steers: QueuedItem[];
    followUps: QueuedItem[];
  } {
    this.inbox.configure({
      steeringMode: this.config.read("steeringMode"),
      followUpMode: this.config.read("followUpMode"),
    });
    return this.inbox.takeAtBoundary(options);
  }

  get inboxDepth(): number {
    return this.inbox.depth;
  }

  async dispose(): Promise<void> {
    await this.ctx.fiber.dispose();
  }

  inspect(): KernelInspect {
    return {
      config: structuredClone(this.config.get()) as KernelConfig,
      maxTurns: this.maxTurns,
      turns: this.turnCount,
      budgetSpent: this.budgetSpent,
      goal: this.goal.current,
      tasks: this.tasks.list(),
      tools: this.tools.names(),
      personas: this.persona.list(),
      activePersonaNames: this.persona.activeNamesList(),
      inboxDepth: this.inbox.depth,
    };
  }
}
