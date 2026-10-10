// The agent's one Codex thread, as the control plane drives it: a prompt
// starts a turn (or a compaction) for a command, a steer joins the running
// turn, an abort stops it, a decision answers an approval Codex asked for.
// What the turn does is reported as events for the command that owns it
// (Emit), read from the app-server's notifications on the root thread
// (sub-agents' threads stay inside their tool calls).

import type { Codex, Notification, Request } from "./appserver.ts";
import type { ItemView } from "./items.ts";
import { randomUUID } from "node:crypto";
import { RpcError } from "./appserver.ts";
import { itemView, textView } from "./items.ts";

type Json = Record<string, unknown>;

export type Emit = (type: string, payload: Json) => void;

export type Answer =
  | { accepted: true }
  | { accepted: false; code: string; reason?: string };

export type Kind = "turn" | "compact";

export interface Timing {
  // Streamed reply text is reported at most this often.
  flushMs: number;
  // A turn that ends while a steer's answer is outstanding waits this long
  // for it: only a steer Codex took belongs to the turn.
  steerAnswerMs: number;
}

const defaultTiming: Timing = { flushMs: 300, steerAnswerMs: 30_000 };

const APPROVALS: Record<string, "command" | "file_change" | "elicitation"> = {
  "item/commandExecution/requestApproval": "command",
  "item/fileChange/requestApproval": "file_change",
  // A plugin's tool asking the user to confirm (docs/architecture/user-attention.md).
  "mcpServer/elicitation/request": "elicitation",
};
// Conservative answers to the requests the product does not show.
const DECLINES: Record<string, unknown> = {
  "item/permissions/requestApproval": { permissions: {} },
  "item/tool/requestUserInput": { answers: {} },
  execCommandApproval: { decision: "denied" },
  applyPatchApproval: { decision: "denied" },
  "item/tool/call": { contentItems: [], success: false },
};
const DECISIONS = new Set(["accept", "decline"]);

interface Steer {
  turnId: string;
  // true once Codex took it (or never answered in time), false if it refused.
  answered: Promise<boolean>;
}

interface Approval {
  commandId: string;
  kind: string;
  requestId: string | number;
  decided: (decision: string) => void;
  decision?: string;
}

const str = (value: unknown): string =>
  typeof value === "string" ? value : "";
const record = (value: unknown): Json =>
  typeof value === "object" && value !== null ? (value as Json) : {};
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
const text = (input: string) => [
  { type: "text" as const, text: input, text_elements: [] },
];

function refusal(error: unknown): Answer {
  return {
    accepted: false,
    code: error instanceof RpcError ? "runtime_refused" : "runtime_exited",
    reason: error instanceof Error ? error.message : String(error),
  };
}

/** Whether an elicitation only asks for a yes or no: a form with no fields. */
function confirmation(params: Json): boolean {
  const schema = record(params.requestedSchema);
  return (
    params.mode === "form" &&
    Object.keys(record(schema.properties)).length === 0
  );
}

function summary(kind: string, params: Json): Json {
  const clip = (value: unknown, n: number) => str(value).slice(0, n) || null;
  if (kind === "elicitation") {
    return {
      server: clip(params.serverName, 100),
      message: clip(params.message, 500),
    };
  }
  const out: Json = { reason: clip(params.reason, 300) };
  if (kind === "command") {
    out.command = clip(params.command, 500);
  }
  return out;
}

function response(kind: string, decision: string): unknown {
  if (kind !== "elicitation") {
    return { decision };
  }
  return decision === "accept"
    ? { action: "accept", content: {}, _meta: null }
    : { action: decision, content: null, _meta: null };
}

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
  // Approvals waiting for the user, by their id.
  private readonly approvals = new Map<string, Approval>();
  // Reply texts of the running turn, by item, and the ones not yet reported.
  private readonly texts = new Map<string, string>();
  private readonly dirty = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  // Notifications are read one at a time, in order; reading may wait.
  private reading: Promise<void> = Promise.resolve();
  // Codex's app-server exited.
  onExit: (code: number | null) => void = () => {};

  constructor(
    private readonly codex: Codex,
    readonly threadId: string,
    private readonly emit: Emit,
    private readonly timing: Timing = defaultTiming,
  ) {
    codex.onNotification((notification) =>
      this.schedule(() => this.read(notification)),
    );
    codex.onRequest((request) => this.ask(request));
    void codex.exited.then((code) => {
      this.cancelApprovals();
      this.onExit(code);
    });
  }

  /** Settles once every notification so far has been read. */
  settled(): Promise<void> {
    return this.reading;
  }

  status(): { command_id: string | null; turn_id: string | null } {
    return { command_id: this.owner, turn_id: this.turnId };
  }

  /** Start the command's turn, or compact the thread; refused while another runs. */
  async prompt(
    commandId: string,
    input: string,
    kind: Kind = "turn",
  ): Promise<Answer> {
    if (this.taken.has(commandId)) {
      return { accepted: true };
    }
    if (this.owner !== null) {
      return { accepted: false, code: "busy" };
    }
    // Owned from now: Codex reports the turn before it answers a compaction.
    this.owner = commandId;
    this.taken.add(commandId);
    try {
      if (kind === "compact") {
        await this.codex.request("thread/compact/start", {
          threadId: this.threadId,
        });
      } else {
        await this.codex.request("turn/start", {
          threadId: this.threadId,
          clientUserMessageId: commandId,
          input: text(input),
        });
      }
      return { accepted: true };
    } catch (error) {
      this.taken.delete(commandId);
      if (this.owner === commandId && this.turnId === null) {
        this.owner = null;
      }
      return refusal(error);
    }
  }

  /** Add the command's input to the running turn; refused without one. */
  async steer(commandId: string, input: string): Promise<Answer> {
    if (this.taken.has(commandId) || this.steers.has(commandId)) {
      return { accepted: true };
    }
    const owner = this.owner;
    const turnId = this.turnId;
    if (owner === null || turnId === null || this.stopped.has(owner)) {
      return { accepted: false, code: "no_active_turn" };
    }
    let answer: (taken: boolean) => void = () => {};
    // Registered first: Codex may echo the steer before it answers.
    this.steers.set(commandId, {
      turnId,
      answered: new Promise((resolve) => (answer = resolve)),
    });
    try {
      await this.codex.request("turn/steer", {
        threadId: this.threadId,
        expectedTurnId: turnId,
        clientUserMessageId: commandId,
        input: text(input),
      });
      answer(true);
      return { accepted: true };
    } catch (error) {
      answer(false);
      this.steers.delete(commandId);
      this.stopped.delete(commandId);
      return refusal(error);
    }
  }

  /** Stop the command's turn, now or as soon as it owns one. */
  async abort(commandId: string): Promise<void> {
    if (commandId === this.owner) {
      this.stopped.add(commandId);
      let elicited = false;
      for (const [id, approval] of this.approvals) {
        if (approval.commandId === commandId) {
          // For a command or file approval "cancel" also interrupts the
          // turn; for a plugin's confirmation it only dismisses the prompt
          // (the tool hears "not confirmed" and the turn goes on).
          elicited ||= approval.kind === "elicitation";
          this.decide(id, "cancel");
        }
      }
      if (this.turnId !== null && (elicited || !this.hasApproval(commandId))) {
        await this.interrupt(this.turnId);
      }
    } else if (this.steers.has(commandId)) {
      this.stopped.add(commandId);
    }
  }

  /** The user's answer to an approval: "accepted" or "not_pending". */
  decide(approvalId: string, decision: string): "accepted" | "not_pending" {
    const approval = this.approvals.get(approvalId);
    if (approval === undefined) {
      return "not_pending";
    }
    if (approval.decision !== undefined) {
      return approval.decision === decision ? "accepted" : "not_pending";
    }
    if (!DECISIONS.has(decision) && decision !== "cancel") {
      return "not_pending";
    }
    approval.decision = decision;
    approval.decided(decision);
    return "accepted";
  }

  private hasApproval(commandId: string): boolean {
    return [...this.approvals.values()].some((a) => a.commandId === commandId);
  }

  private cancelApprovals(): void {
    for (const id of [...this.approvals.keys()]) {
      this.decide(id, "cancel");
    }
  }

  private async interrupt(turnId: string): Promise<void> {
    try {
      await this.codex.request("turn/interrupt", {
        threadId: this.threadId,
        turnId,
      });
    } catch (error) {
      console.warn("turn/interrupt failed", error);
    }
  }

  /** A request from Codex: an approval for the user, or a conservative no. */
  private async ask(request: Request): Promise<unknown> {
    const kind = APPROVALS[request.method];
    if (kind === undefined) {
      if (request.method in DECLINES) {
        return DECLINES[request.method];
      }
      throw new Error(`${request.method} is not supported`);
    }
    const params = record(request.params);
    const commandId = this.owner;
    if (
      commandId === null ||
      (kind === "elicitation" && !confirmation(params))
    ) {
      return response(kind, "decline");
    }
    const approvalId = randomUUID();
    const decision = await new Promise<string>((decided) => {
      this.approvals.set(approvalId, {
        commandId,
        kind,
        requestId: request.id,
        decided,
      });
      this.emit("approval.requested", {
        approval_id: approvalId,
        command_id: commandId,
        kind,
        summary: summary(kind, params),
      });
      if (this.stopped.has(commandId)) {
        this.decide(approvalId, "cancel");
      }
    });
    this.approvals.delete(approvalId);
    this.emit("approval.applied", { approval_id: approvalId, decision });
    return response(kind, decision);
  }

  private schedule(step: () => void | Promise<void>): void {
    this.reading = this.reading.then(step).catch((error: unknown) => {
      console.error("Reading the app-server failed", error);
    });
  }

  private async read(notification: Notification): Promise<void> {
    const params = record(notification.params);
    if (notification.method === "serverRequest/resolved") {
      // Codex no longer waits on the request (the turn ended without it).
      for (const [id, approval] of this.approvals) {
        if (String(approval.requestId) === String(params.requestId)) {
          this.decide(id, "cancel");
        }
      }
      return;
    }
    if (
      typeof params.threadId === "string" &&
      params.threadId !== this.threadId
    ) {
      return;
    }
    switch (notification.method) {
      case "turn/started":
        this.turnStarted(params);
        break;
      case "item/agentMessage/delta":
        this.delta(params);
        break;
      case "item/started":
      case "item/completed":
        this.item(params, notification.method === "item/completed");
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
      void this.interrupt(id);
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
      if (this.turnId !== null) {
        void this.interrupt(this.turnId);
      }
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
