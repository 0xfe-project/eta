/**
 * The door daemons come in by.
 *
 * Two routes, neither behind the browser's gate (a daemon has no cookie and sends no origin) and
 * each guarded by what it carries instead:
 *
 * - `POST /machines/enroll` trades a one-time install code for a place on the primary. The machine
 *   is made `pending`; it is not let in until the user approves its fingerprint.
 * - `GET /machines/connect` (a WebSocket) is the link. The daemon proves itself with its device
 *   credential in the handshake; the primary checks the digest. Every connection that gets in is
 *   a new epoch, and a newer one from the same device takes the older one's place.
 *
 * The hub knows who is connected and speaks the link's rules. What the link is *for* (sessions,
 * models, tools) is the business of the code that asks the hub for a machine's link.
 */
import type {
  MachineActionArgs,
  MachineActionResults,
} from "@eta/client-contracts";
import type { WebSocketEndpoint } from "@eta/server";
import type { MachineRecord, MachineStore } from "./store";
import {
  ENROLL_PATH,
  LINK_CLOSE,
  LINK_LIMITS,
  LINK_PATH,
} from "@eta/client-contracts";
import { LinkError, Peer } from "@eta/daemon";
import { PipeClient } from "./pipe";
import { EnrollmentError } from "./store";

/** A machine's link while it is up: ask the machine things, or serve it. */
export interface MachineLink {
  readonly machineId: string;
  readonly epoch: number;
  readonly peer: Peer;
  readonly pipe: PipeClient;
  /** `machine.<action>` on the daemon. */
  machine: <A extends keyof MachineActionArgs>(
    action: A,
    args: MachineActionArgs[A],
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ) => Promise<MachineActionResults[A]>;
}

interface Connection extends MachineLink {
  socket: { close: (code?: number, reason?: string) => void };
  /** Has the pipe come up and the machine said who it is. */
  ready: boolean;
  /** Is the machine let in. */
  approved: boolean;
  gone: boolean;
}

export interface MachineHubOptions {
  machines: MachineStore;
  /** The machines moved (status, facts). */
  changed: () => void;
  warn: (message: string) => void;
  /** How long the link may be silent. Defaults to the link's own limit. */
  silenceMs?: number | undefined;
  now?: (() => number) | undefined;
}

/** Bad codes tolerated per window before the door stops listening for a while. */
const MAX_BAD_CODES = 20;
const BAD_CODE_WINDOW_MS = 10 * 60 * 1000;
/** An enrol request is a few hundred bytes. */
const MAX_ENROLL_BODY = 4_096;

export class MachineHub {
  readonly #options: MachineHubOptions;
  readonly #connections = new Map<string, Connection>();
  readonly #ready = new Set<(link: MachineLink) => void>();
  readonly #lost = new Set<(machineId: string, reason: string) => void>();
  #epoch: number;
  #badCodes: number[] = [];

  constructor(options: MachineHubOptions) {
    this.#options = options;
    // Epochs only have to increase; the clock makes them increase across restarts too.
    this.#epoch = (options.now ?? Date.now)();
  }

  /* ---------------------------------------------------------------- queries */

  /** The machine's link, when it is up and serving. */
  link(machineId: string): MachineLink | undefined {
    const connection = this.#connections.get(machineId);
    return connection?.ready === true ? connection : undefined;
  }

  onReady(listener: (link: MachineLink) => void): () => void {
    this.#ready.add(listener);
    return () => void this.#ready.delete(listener);
  }

  onLost(listener: (machineId: string, reason: string) => void): () => void {
    this.#lost.add(listener);
    return () => void this.#lost.delete(listener);
  }

  /* ---------------------------------------------------------------- decisions */

  /** Let a pending machine in; if it is already knocking, it comes in now. */
  approve(machineId: string, fingerprint: string): MachineRecord {
    const machine = this.#options.machines.approve(machineId, fingerprint);
    if (machine === undefined) throw new Error("no such machine");
    const connection = this.#connections.get(machineId);
    if (connection !== undefined && !connection.approved) {
      connection.approved = true;
      connection.peer.sendCtl({ op: "approved" });
      void this.#activate(connection);
    }
    this.#options.changed();
    return this.#options.machines.get(machineId)!;
  }

  /** Close the door on a machine and cut the link, if there is one. */
  revoke(machineId: string): MachineRecord {
    const machine = this.#options.machines.revoke(machineId);
    if (machine === undefined) throw new Error("no such machine");
    const connection = this.#connections.get(machineId);
    if (connection !== undefined) {
      this.#drop(connection, "revoked", LINK_CLOSE.revoked);
    }
    this.#options.changed();
    return machine;
  }

  /** Cut every link (the host is stopping). */
  close(): void {
    for (const connection of [...this.#connections.values()])
      this.#drop(connection, "the host is stopping", 1001);
  }

  /* ---------------------------------------------------------------- the link */

  readonly endpoint: WebSocketEndpoint = {
    path: LINK_PATH,
    accept: (request) => {
      const credential = request.headers
        .get("authorization")
        ?.replace(/^Bearer\s+/i, "");
      const split = credential?.indexOf(".") ?? -1;
      const machine =
        credential === undefined || split <= 0
          ? undefined
          : this.#options.machines.authenticate(
              credential.slice(0, split),
              credential.slice(split + 1),
            );
      if (machine === undefined) {
        // Not why: a caller that is not a machine we know learns nothing.
        return new Response("unauthorized", { status: 401 });
      }
      return { context: machine };
    },
    open: (socket, context) => {
      const machine = context as MachineRecord;
      // A newer connection from the same device takes the older one's place, now: whatever the
      // old one was doing for the primary fails as unknown rather than waiting to be noticed.
      const older = this.#connections.get(machine.id);
      if (older !== undefined)
        this.#drop(older, "superseded", LINK_CLOSE.superseded);

      const epoch = ++this.#epoch;
      // The pipe client needs the peer and the peer needs the pipe client's `receive`; the
      // connection object ties them.
      const connection = { gone: false, ready: false } as Connection;
      const peer = new Peer({
        send: (text) => socket.send(text),
        close: (code, reason) => socket.close(code, reason),
        onPipe: (frame) => connection.pipe.receive(frame),
        warn: this.#options.warn,
      });
      const pipe = new PipeClient(peer);
      Object.assign(connection, {
        machineId: machine.id,
        epoch,
        peer,
        pipe,
        socket,
        approved: machine.status !== "pending",
        machine: (
          action: string,
          args: unknown,
          options?: { timeoutMs?: number; signal?: AbortSignal },
        ) => pipe.call("machine", action, args, options),
      });
      this.#connections.set(machine.id, connection);
      peer.watch({
        silenceMs: this.#options.silenceMs ?? LINK_LIMITS.silenceMs,
      });
      peer.sendCtl({
        op: "welcome",
        machineId: machine.id,
        epoch,
        status: connection.approved ? "approved" : "pending",
      });
      if (connection.approved) void this.#activate(connection);
      return {
        message: (text) => peer.receive(text),
        close: () => this.#gone(connection, "the daemon closed the link"),
      };
    },
  };

  /** The pipe came up and the machine is let in: it says who it is, and it is online. */
  async #activate(connection: Connection): Promise<void> {
    const { machines } = this.#options;
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        connection.pipe.ready,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(new LinkError("timeout", "the daemon did not say hello")),
            LINK_LIMITS.callTimeoutMs,
          );
        }),
      ]).finally(() => clearTimeout(timer));
      const facts = await connection.machine("info", {});
      if (connection.gone) return;
      machines.setFacts(connection.machineId, {
        home: facts.home,
        os: facts.os,
      });
      machines.setStatus(connection.machineId, "online", Date.now());
      connection.ready = true;
      this.#options.changed();
      for (const listener of this.#ready) listener(connection);
    } catch (error) {
      if (connection.gone) return;
      this.#options.warn(
        `[eta] machine ${connection.machineId} did not come up: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.#drop(connection, "did not come up", LINK_CLOSE.protocol);
    }
  }

  /** End a connection from this side. */
  #drop(connection: Connection, reason: string, code: number): void {
    this.#gone(connection, reason);
    try {
      connection.socket.close(code, reason);
    } catch {
      // Already closed.
    }
  }

  /** A connection is over, however it ended. */
  #gone(connection: Connection, reason: string): void {
    if (connection.gone) return;
    connection.gone = true;
    connection.peer.markLost(reason);
    connection.pipe.lost(reason);
    // A newer connection may already have taken the slot; only the holder of it speaks for the
    // machine.
    if (this.#connections.get(connection.machineId) !== connection) return;
    this.#connections.delete(connection.machineId);
    const { machines } = this.#options;
    const row = machines.get(connection.machineId);
    if (connection.ready && row?.status === "online")
      machines.setStatus(connection.machineId, "offline", Date.now());
    this.#options.changed();
    if (connection.ready) {
      for (const listener of this.#lost) listener(connection.machineId, reason);
    }
  }

  /* ---------------------------------------------------------------- enrolling */

  /** `POST /machines/enroll`; anything else is not this route's. */
  async enroll(request: Request): Promise<Response | undefined> {
    if (new URL(request.url).pathname !== ENROLL_PATH) return undefined;
    if (request.method !== "POST")
      return new Response("method not allowed", { status: 405 });
    const now = (this.#options.now ?? Date.now)();
    this.#badCodes = this.#badCodes.filter(
      (at) => now - at < BAD_CODE_WINDOW_MS,
    );
    if (this.#badCodes.length >= MAX_BAD_CODES)
      return new Response("too many bad codes; try again later", {
        status: 429,
      });
    const length = Number(request.headers.get("content-length") ?? "0");
    if (length > MAX_ENROLL_BODY)
      return new Response("too big", { status: 413 });
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return new Response("bad request", { status: 400 });
    }
    const text = (key: string): string | undefined =>
      typeof body[key] === "string" && (body[key] as string).length <= 512
        ? (body[key] as string)
        : undefined;
    const code = text("code");
    const fingerprint = text("fingerprint");
    if (code === undefined || fingerprint === undefined)
      return new Response("bad request", { status: 400 });
    try {
      const machine = this.#options.machines.exchange(
        {
          code,
          fingerprint,
          hostname: text("hostname") ?? "",
          home: text("home") ?? "",
          os: text("os") ?? "",
        },
        now,
      );
      this.#options.changed();
      return Response.json({ machineId: machine.id });
    } catch (error) {
      if (!(error instanceof EnrollmentError)) throw error;
      this.#badCodes.push(now);
      this.#options.warn(`[eta] an install code was refused: ${error.message}`);
      // One answer for every way a code can be wrong.
      return new Response("invalid or expired code", { status: 403 });
    }
  }
}
