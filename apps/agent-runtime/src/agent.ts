// The agent's one Codex session, as the control plane drives it: a prompt
// starts a turn for a command, a steer joins the running turn, an abort stops
// it. What the turn does is reported as events for the command that owns it
// (Emit). oar opens the session and speaks Codex's app-server protocol; the
// turn's facts are read from Codex's own notifications on oar's record stream,
// root thread only (sub-agents' threads stay inside their tool calls).

import type { RawEvent, Session } from "@botiverse/oar";
import type { ItemView } from "./items.ts";
import { itemView, textView } from "./items.ts";

type Json = Record<string, unknown>;

export type Emit = (type: string, payload: Json) => void;

export type Answer =
  | { accepted: true }
  | { accepted: false; code: string; reason?: string };

export interface Timing {
  // Streamed reply text is reported at most this often.
  flushMs: number;
  // A turn that ends while a steer's answer is outstanding waits this long
  // for it: only a steer Codex took belongs to the turn.
  steerAnswerMs: number;
}

const defaultTiming: Timing = { flushMs: 300, steerAnswerMs: 30_000 };

interface Steer {
  turnId: string;
  // true once Codex took it (or never answered in time), false if it refused.
  answered: Promise<boolean>;
}

const str = (value: unknown): string =>
  typeof value === "string" ? value : "";
const record = (value: unknown): Json =>
  typeof value === "object" && value !== null ? (value as Json) : {};
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class Agent {
  // The command whose turn runs (or is starting), and Codex's id for the turn.
  private owner: string | null = null;
  private turnId: string | null = null;
  // Commands this runtime took: asking again changes nothing.
  private readonly taken = new Set<string>();
  // Commands asked to stop before their turn (or a steer before it took the
  // turn over): stopped as soon as they own a running turn.
  private readonly stopped = new Set<string>();
  // Steers sent to the running turn and not yet echoed by Codex.
  private readonly steers = new Map<string, Steer>();
  // Reply texts of the running turn, by item, and the ones not yet reported.
  private readonly texts = new Map<string, string>();
  private readonly dirty = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  // Records are read one at a time, in order; reading may wait (steers).
  private reading: Promise<void> = Promise.resolve();
  // Codex's app-server exited.
  onExit: (code: number | null) => void = () => {};

  constructor(
    private readonly session: Session,
    private readonly emit: Emit,
    private readonly timing: Timing = defaultTiming,
  ) {
    session.rawEvents((event) => this.schedule(() => this.read(event)));
  }

  /** Settles once every record so far has been read. */
  settled(): Promise<void> {
    return this.reading;
  }

  status(): { command_id: string | null; turn_id: string | null } {
    return { command_id: this.owner, turn_id: this.turnId };
  }

  /** Start the command's turn; refused while another runs. */
  async prompt(commandId: string, text: string): Promise<Answer> {
    if (this.taken.has(commandId)) {
      return { accepted: true };
    }
    if (this.owner !== null) {
      return { accepted: false, code: "busy" };
    }
    // Owned from now: Codex may report the turn before it answers.
    this.owner = commandId;
    this.taken.add(commandId);
    const outcome = await this.session.prompt(text, { inputId: commandId });
    if (outcome.kind === "accepted") {
      return { accepted: true };
    }
    this.taken.delete(commandId);
    if (this.owner === commandId && this.turnId === null) {
      this.owner = null;
    }
    return { accepted: false, code: outcome.code, reason: outcome.reason };
  }

  /** Add the command's input to the running turn; refused without one. */
  async steer(commandId: string, text: string): Promise<Answer> {
    if (this.taken.has(commandId) || this.steers.has(commandId)) {
      return { accepted: true };
    }
    if (
      this.session.steer === undefined ||
      this.owner === null ||
      this.turnId === null ||
      this.stopped.has(this.owner)
    ) {
      return { accepted: false, code: "no_active_turn" };
    }
    let answer: (taken: boolean) => void = () => {};
    // Registered first: Codex may echo the steer before it answers.
    this.steers.set(commandId, {
      turnId: this.turnId,
      answered: new Promise((resolve) => (answer = resolve)),
    });
    const outcome = await this.session.steer(text, { inputId: commandId });
    answer(outcome.kind === "accepted");
    if (outcome.kind === "accepted") {
      return { accepted: true };
    }
    this.steers.delete(commandId);
    this.stopped.delete(commandId);
    return { accepted: false, code: outcome.code, reason: outcome.reason };
  }

  /** Stop the command's turn, now or as soon as it owns one. */
  async abort(commandId: string): Promise<void> {
    if (commandId === this.owner) {
      this.stopped.add(commandId);
      if (this.turnId !== null) {
        await this.session.abort();
      }
    } else if (this.steers.has(commandId)) {
      this.stopped.add(commandId);
    }
  }

  private schedule(step: () => void | Promise<void>): void {
    this.reading = this.reading.then(step).catch((error: unknown) => {
      console.error("Reading the session failed", error);
    });
  }

  private async read(event: RawEvent): Promise<void> {
    if (event.kind === "response" && event.body.kind === "exited") {
      this.onExit(event.body.code);
      return;
    }
    if (event.kind !== "frame" || event.sessionId !== this.session.id) {
      return;
    }
    const params = record(event.body.native);
    switch (event.body.type) {
      case "turn/started":
        this.turnStarted(params);
        break;
      case "item/agentMessage/delta":
        this.delta(params);
        break;
      case "item/started":
      case "item/completed":
        this.item(params, event.body.type === "item/completed");
        break;
      case "turn/completed":
        await this.turnCompleted(params);
        break;
    }
  }

  private turnStarted(params: Json): void {
    const id = str(record(params.turn).id);
    if (this.owner === null || id === "") {
      return; // a turn no command asked for
    }
    this.turnId = id;
    this.emit("turn.started", { command_id: this.owner, turn_id: id });
    if (this.stopped.has(this.owner)) {
      void this.session.abort();
    }
  }

  private delta(params: Json): void {
    const id = str(params.itemId);
    if (id === "" || this.owner === null) {
      return;
    }
    this.texts.set(id, (this.texts.get(id) ?? "") + str(params.delta));
    this.dirty.add(id);
    this.flushTimer ??= setTimeout(
      () => this.schedule(() => this.flush()),
      this.timing.flushMs,
    );
  }

  /** Report the reply texts changed since the last report. */
  private flush(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    for (const id of this.dirty) {
      this.report(textView(id, this.texts.get(id) ?? ""));
    }
    this.dirty.clear();
  }

  private item(params: Json, completed: boolean): void {
    const item = record(params.item);
    if (completed) {
      this.dirty.delete(str(item.id)); // the completed item has all of it
    }
    this.flush();
    const clientId = str(item.clientId);
    if (item.type === "userMessage" && this.steers.has(clientId)) {
      // Codex took the steer in: what follows answers it.
      this.takeSteer(clientId);
    }
    const view = itemView(item, completed);
    if (view !== null) {
      this.report(view);
    }
  }

  private report(item: ItemView): void {
    if (this.owner !== null) {
      this.emit("item.updated", { command_id: this.owner, item });
    }
  }

  /**
   * Hand the running turn over to the steer. A stop asked for the steer, or
   * for the command it takes over, stops the turn: the steer now owns it.
   */
  private takeSteer(steerId: string): void {
    const previous = this.owner;
    if (previous === null) {
      return;
    }
    this.steers.delete(steerId);
    const stop = this.stopped.has(steerId) || this.stopped.has(previous);
    this.stopped.delete(previous);
    this.taken.add(steerId);
    this.emit("turn.steered", {
      command_id: previous,
      steer_command_id: steerId,
      turn_id: this.turnId,
    });
    this.owner = steerId;
    if (stop) {
      this.stopped.add(steerId);
      void this.session.abort();
    }
  }

  private async turnCompleted(params: Json): Promise<void> {
    this.flush();
    const turn = record(params.turn);
    const turnId = str(turn.id) || this.turnId;
    // Steers Codex accepted but never echoed still went to this turn; never
    // run them again. One still waiting for its answer is waited for:
    // refused (the turn had ended), it was never part of it.
    for (const [id, steer] of [...this.steers]) {
      if (steer.turnId !== turnId) {
        continue;
      }
      const taken = await Promise.race([
        steer.answered,
        sleep(this.timing.steerAnswerMs).then(() => true),
      ]);
      if (taken && this.steers.has(id)) {
        this.takeSteer(id);
      }
    }
    if (this.owner !== null) {
      const status =
        turn.status === "completed" || turn.status === "interrupted"
          ? turn.status
          : "failed";
      this.emit("turn.completed", {
        command_id: this.owner,
        turn_id: turnId,
        status,
      });
      this.stopped.delete(this.owner);
    }
    this.owner = null;
    this.turnId = null;
    this.texts.clear();
    this.dirty.clear();
  }
}
