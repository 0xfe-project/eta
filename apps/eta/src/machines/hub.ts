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
 * - `GET /machines/daemon/<platform>` hands a daemon the build this primary carries for it, on the
 *   same credential: what a daemon fetches when it is told to replace itself.
 * - `GET /machines/install.sh?code=` and `GET /machines/install/<platform>?code=` are what a new
 *   machine runs and fetches to install itself (`install-script.ts`): they answer while the
 *   install code is good, and do not use it up.
 *
 * A daemon is part of the primary: when one comes up reporting another build than the one carried
 * (`builds.ts`), it is told to replace itself before it is let do anything else, and comes back as
 * the new build. One that cannot (not run by a service, no build for its platform) is let in as it
 * is, with the reason on its row, unless it speaks another link protocol, which it cannot be let in
 * with at all.
 *
 * The hub knows who is connected and speaks the link's rules. What the link is *for* (sessions,
 * models, tools) is the business of the code that asks the hub for a machine's link.
 */
import type {
  DaemonServiceParams,
  DaemonServiceResults,
  MachineActionArgs,
  MachineActionResults,
  MachineFacts,
  MachineView,
} from "@eta/client-contracts";
import type { WebSocketEndpoint } from "@eta/server";
import type { DaemonBuilds } from "./builds";
import type { MachineRecord, MachineStore } from "./store";
import {
  DAEMON_DOWNLOAD_PATH,
  ENROLL_PATH,
  INSTALL_DOWNLOAD_PATH,
  INSTALL_SCRIPT_PATH,
  LINK_CLOSE,
  LINK_LIMITS,
  LINK_PATH,
  LINK_PROTOCOL,
} from "@eta/client-contracts";
import { LinkError, Peer } from "@eta/daemon";
import { installScript } from "./install-script";
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
  /** A call to the daemon that may take a while (a run, a script): it runs beside the pipe. */
  daemon: <M extends keyof DaemonServiceParams>(
    method: M,
    params: DaemonServiceParams[M],
    options?: {
      timeoutMs?: number;
      signal?: AbortSignal;
      onEvent?: (event: unknown) => void;
    },
  ) => Promise<DaemonServiceResults[M]>;
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
  /**
   * What the primary does for a machine whose link has come up: it answers the machine's calls.
   * Called once per connection, as soon as the machine is let in: before it is reported ready, and
   * before it has said anything.
   */
  serve?: ((link: MachineLink) => void) | undefined;
  /** The daemon builds this primary carries; without them daemons are left at their builds. */
  builds?: DaemonBuilds | undefined;
  /**
   * Who an enrolling machine is, when that can be told without the user: the tailnet node it is,
   * when Tailscale says it belongs to the user this host runs as. Such a machine is let in at once
   * instead of waiting for its fingerprint to be approved.
   */
  identify?:
    | ((request: Request) => Promise<{ node: string } | undefined>)
    | undefined;
}

/** How long a daemon has to come back after it was told to replace itself. */
const UPDATING_MS = 3 * 60 * 1000;
/** How soon the same daemon is told to move to the same build again, after a try. */
const RETRY_MS = 60 * 60 * 1000;
/** How long fetching, checking and swapping a build may take on the daemon. */
const UPGRADE_TIMEOUT_MS = 10 * 60 * 1000;

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
  /** Machines told to replace themselves, until they come back (or do not, in time). */
  readonly #updating = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * When each machine was last told to move to each build (`machine:version`), and whether it said
   * it had swapped the build in.
   */
  readonly #tried = new Map<string, { at: number; swapped: boolean }>();

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

  /** Where the machine's daemon stands against the build this primary carries. */
  buildOf(machine: MachineRecord): MachineView["build"] {
    if (machine.kind !== "daemon") return null;
    if (this.#updating.has(machine.id)) return "updating";
    const wanted = this.#options.builds?.version();
    if (wanted === undefined || machine.version === null) return null;
    return machine.version === wanted ? "current" : "outdated";
  }

  /**
   * Bring an online machine to the carried build now, whenever it was last tried. Resolves when the
   * daemon has swapped the build in (it then restarts and comes back) or has said why it cannot.
   */
  async upgrade(machineId: string): Promise<MachineRecord> {
    const connection = this.#connections.get(machineId);
    const machine = this.#options.machines.get(machineId);
    if (machine === undefined) throw new Error("no such machine");
    if (connection === undefined || connection.gone || !connection.approved)
      throw new Error(`${machine.name} is not connected`);
    const replaced = await this.#bringUpToDate(
      connection,
      {
        version: machine.version ?? "",
        platform: machine.platform ?? undefined,
        install: machine.install ?? undefined,
      },
      true,
    );
    const after = this.#options.machines.get(machineId)!;
    if (!replaced && after.updateError !== null)
      throw new Error(after.updateError);
    return after;
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
    for (const timer of this.#updating.values()) clearTimeout(timer);
    this.#updating.clear();
  }

  /* ---------------------------------------------------------------- the link */

  readonly endpoint: WebSocketEndpoint = {
    path: LINK_PATH,
    accept: (request) => {
      const machine = this.#authenticate(request);
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
        daemon: (
          method: string,
          params: unknown,
          options?: {
            timeoutMs?: number;
            signal?: AbortSignal;
            onEvent?: (event: unknown) => void;
          },
        ) => peer.call(method, params, options),
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
    // Answering the machine starts now, not when it is reported ready: what a daemon says the
    // moment it is let in (a question asked while the link was down) must find a listener.
    this.#options.serve?.(connection);
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
      // Whatever it was told before, this is the build it came back as.
      this.#settled(connection.machineId);
      machines.setFacts(connection.machineId, {
        home: facts.home,
        os: facts.os,
        version: facts.version,
        platform: facts.platform,
        install: facts.install,
        protocol: facts.protocol,
      });
      // A daemon on another build is replaced before it is let do anything: it restarts as the
      // carried one and comes back on a new connection.
      if (await this.#bringUpToDate(connection, facts, false)) return;
      if (connection.gone) return;
      const protocol = facts.protocol ?? 1;
      if (protocol !== LINK_PROTOCOL) {
        machines.setUpdateError(
          connection.machineId,
          `it speaks link protocol ${protocol} and this primary ${LINK_PROTOCOL}; it has to be updated to be used`,
        );
        this.#options.changed();
        this.#drop(connection, "another link protocol", LINK_CLOSE.protocol);
        return;
      }
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

  /**
   * Tell a daemon on another build than the carried one to replace itself. True when it did (it is
   * about to restart); false when there was nothing to do or it could not, with the reason on the
   * machine's row. `force` tries again even if this build was tried lately.
   */
  async #bringUpToDate(
    connection: Connection,
    facts: {
      version: string;
      platform?: string | undefined;
      install?: MachineFacts["install"];
    },
    force: boolean,
  ): Promise<boolean> {
    const { machines, builds } = this.#options;
    const id = connection.machineId;
    const wanted = builds?.version();
    if (wanted === undefined) {
      if (force)
        machines.setUpdateError(id, "this primary carries no daemon builds");
      return false;
    }
    if (facts.version === wanted) {
      machines.setUpdateError(id, null);
      return false;
    }
    const build =
      facts.platform === undefined ? undefined : builds?.get(facts.platform);
    let refused: string | undefined;
    if (build === undefined)
      refused = `this primary carries no daemon build for ${facts.platform ?? "its platform"}`;
    else if (facts.install !== "service")
      refused =
        facts.install === "source"
          ? "it runs from source; update its checkout"
          : "it is not run by a service, so it cannot restart itself; run `eta-daemon install-service` there";
    if (refused !== undefined || build === undefined) {
      machines.setUpdateError(id, refused ?? null);
      this.#options.changed();
      return false;
    }
    const now = (this.#options.now ?? Date.now)();
    const key = `${id}:${wanted}`;
    const last = this.#tried.get(key);
    if (!force && last !== undefined && now - last.at < RETRY_MS) {
      // It swapped the build in and is back on another one: the new build put the old one back.
      if (last.swapped) {
        machines.setUpdateError(
          id,
          `the update to ${wanted} did not hold; it went back to ${facts.version}`,
        );
        this.#options.changed();
      }
      return false;
    }
    const tried = { at: now, swapped: false };
    this.#tried.set(key, tried);
    this.#updating.set(
      id,
      setTimeout(() => {
        this.#settled(id);
        this.#options.changed();
      }, UPDATING_MS),
    );
    this.#options.changed();
    try {
      const answer = await connection.daemon(
        "upgrade",
        { version: build.version, sha256: build.sha256 },
        { timeoutMs: UPGRADE_TIMEOUT_MS },
      );
      if (answer.ok) {
        tried.swapped = true;
        machines.setUpdateError(id, null);
        this.#options.changed();
        return true;
      }
      machines.setUpdateError(id, answer.reason);
    } catch (error) {
      machines.setUpdateError(
        id,
        error instanceof Error ? error.message : String(error),
      );
    }
    this.#settled(id);
    this.#options.changed();
    return false;
  }

  /** It came back, or gave up, or ran out of time: it is not being replaced any more. */
  #settled(machineId: string): void {
    const timer = this.#updating.get(machineId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.#updating.delete(machineId);
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

  /* ---------------------------------------------------------------- routes */

  /** The hub's HTTP routes: enrolling, a daemon fetching its build, a new machine installing. */
  async route(request: Request): Promise<Response | undefined> {
    return (
      (await this.enroll(request)) ??
      this.download(request) ??
      this.install(request)
    );
  }

  /**
   * The install script and the build it fetches, for whoever holds a good install code. A wrong
   * code counts against the same limit as a wrong code at the enrol door.
   */
  install(request: Request): Response | undefined {
    const url = new URL(request.url);
    const script = url.pathname === INSTALL_SCRIPT_PATH;
    if (!script && !url.pathname.startsWith(`${INSTALL_DOWNLOAD_PATH}/`))
      return undefined;
    if (request.method !== "GET")
      return new Response("method not allowed", { status: 405 });
    const now = (this.#options.now ?? Date.now)();
    this.#badCodes = this.#badCodes.filter(
      (at) => now - at < BAD_CODE_WINDOW_MS,
    );
    if (this.#badCodes.length >= MAX_BAD_CODES)
      return new Response("too many bad codes; try again later", {
        status: 429,
      });
    const code = url.searchParams.get("code") ?? "";
    if (code.length > 512 || !this.#options.machines.codeIsGood(code, now)) {
      this.#badCodes.push(now);
      return new Response("invalid or expired code\n", { status: 403 });
    }
    if (script)
      return new Response(installScript(url.origin, code), {
        headers: {
          "content-type": "text/x-shellscript; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    const build = this.#options.builds?.get(
      url.pathname.slice(INSTALL_DOWNLOAD_PATH.length + 1),
    );
    if (build === undefined)
      return new Response(
        "this host carries no daemon build for that platform\n",
        {
          status: 404,
        },
      );
    return new Response(Bun.file(build.path), {
      headers: {
        "content-type": "application/octet-stream",
        "cache-control": "no-store",
      },
    });
  }

  /** `GET /machines/daemon/<platform>`, for a daemon that has been let in. */
  download(request: Request): Response | undefined {
    const { pathname } = new URL(request.url);
    if (!pathname.startsWith(`${DAEMON_DOWNLOAD_PATH}/`)) return undefined;
    if (request.method !== "GET")
      return new Response("method not allowed", { status: 405 });
    const machine = this.#authenticate(request);
    if (machine === undefined || machine.status === "pending")
      return new Response("unauthorized", { status: 401 });
    const build = this.#options.builds?.get(
      pathname.slice(DAEMON_DOWNLOAD_PATH.length + 1),
    );
    if (build === undefined)
      return new Response("no such build", { status: 404 });
    return new Response(Bun.file(build.path), {
      headers: {
        "content-type": "application/octet-stream",
        "cache-control": "no-store",
      },
    });
  }

  /** The machine whose device credential the request carries, if it is good. */
  #authenticate(request: Request): MachineRecord | undefined {
    const credential = request.headers
      .get("authorization")
      ?.replace(/^Bearer\s+/i, "");
    const split = credential?.indexOf(".") ?? -1;
    return credential === undefined || split <= 0
      ? undefined
      : this.#options.machines.authenticate(
          credential.slice(0, split),
          credential.slice(split + 1),
        );
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
    // Read at most what an enrol request can be, whatever the headers claim.
    let body: Record<string, unknown>;
    try {
      const raw = await request.text();
      if (raw.length > MAX_ENROLL_BODY)
        return new Response("too big", { status: 413 });
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return new Response("bad request", { status: 400 });
    }
    if (typeof body !== "object" || body === null || Array.isArray(body))
      return new Response("bad request", { status: 400 });
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
      // The user's own tailnet node needs no fingerprint compared: Tailscale has said who it is.
      const known = await this.#options
        .identify?.(request)
        .catch((error: unknown) => {
          this.#options.warn(
            `[eta] could not tell who enrolled ${machine.name}: ${error instanceof Error ? error.message : String(error)}`,
          );
          return undefined;
        });
      if (known !== undefined) {
        this.#options.machines.admit(machine.id);
        this.#options.machines.setTailnetNode(machine.id, known.node);
      }
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
