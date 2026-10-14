// A client of Codex's app-server (JSON-RPC 2.0, one message per line on the
// process's stdio). The protocol's types are generated from the pinned Codex
// (`bun run generate`: `codex app-server generate-ts`, into src/protocol).

import type { ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type { ClientRequest } from "./protocol/ClientRequest";
import type { InitializeResponse } from "./protocol/InitializeResponse";
import type { ServerNotification } from "./protocol/ServerNotification";
import type { ServerRequest } from "./protocol/ServerRequest";
import type { ThreadCompactStartResponse } from "./protocol/v2/ThreadCompactStartResponse";
import type { ThreadResumeResponse } from "./protocol/v2/ThreadResumeResponse";
import type { ThreadStartResponse } from "./protocol/v2/ThreadStartResponse";
import type { TurnInterruptResponse } from "./protocol/v2/TurnInterruptResponse";
import type { TurnStartResponse } from "./protocol/v2/TurnStartResponse";
import type { TurnSteerResponse } from "./protocol/v2/TurnSteerResponse";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

type Method = ClientRequest["method"];
export type Params<M extends Method> = Extract<
  ClientRequest,
  { method: M }
>["params"];

/** What each request the runtime makes answers. */
interface Results {
  initialize: InitializeResponse;
  "thread/start": ThreadStartResponse;
  "thread/resume": ThreadResumeResponse;
  "turn/start": TurnStartResponse;
  "turn/steer": TurnSteerResponse;
  "turn/interrupt": TurnInterruptResponse;
  "thread/compact/start": ThreadCompactStartResponse;
}

export type Notification = ServerNotification;
export type Request = ServerRequest;

/** A JSON-RPC error the app-server answered with. */
export class RpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
  ) {
    super(`${method}: ${message}`);
  }
}

/** The app-server as the agent uses it; tests fake this. */
export interface Codex {
  request: <M extends keyof Results>(
    method: M,
    params: Params<M>,
  ) => Promise<Results[M]>;
  /** Notifications, in order. */
  onNotification: (handler: (notification: Notification) => void) => void;
  /** Requests from the app-server; the handler's result is the answer. */
  onRequest: (handler: (request: Request) => Promise<unknown>) => void;
  /** Settles when the app-server exits, with its exit code. */
  readonly exited: Promise<number | null>;
  close: () => void;
}

interface Pending {
  method: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

export class AppServer implements Codex {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private notified: (notification: Notification) => void = () => {};
  private asked: (request: Request) => Promise<unknown> = async () => ({});
  readonly exited: Promise<number | null>;

  constructor(
    private readonly input: Writable,
    output: Readable,
    exited: Promise<number | null>,
    private readonly stop: () => void = () => {},
  ) {
    createInterface({ input: output, crlfDelay: Infinity }).on("line", (line) =>
      this.read(line),
    );
    this.exited = exited.then((code) => {
      for (const [id, request] of this.pending) {
        request.reject(new Error(`${request.method}: the app-server exited`));
        this.pending.delete(id);
      }
      return code;
    });
  }

  /** Starts `command app-server args…` and initializes it. */
  static async start(
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    cwd: string,
  ): Promise<AppServer> {
    const child: ChildProcess = spawn(command, ["app-server", ...args], {
      env,
      cwd,
      stdio: ["pipe", "pipe", "inherit"],
    });
    const exited = new Promise<number | null>((resolve) => {
      child.once("exit", (code) => resolve(code));
      child.once("error", () => resolve(null));
    });
    const server = new AppServer(child.stdin!, child.stdout!, exited, () =>
      child.kill("SIGTERM"),
    );
    await server.request("initialize", {
      clientInfo: {
        name: "axp_runtime",
        title: "AXP Agent Runtime",
        version: "1",
      },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    server.send({ method: "initialized" });
    return server;
  }

  request<M extends keyof Results>(
    method: M,
    params: Params<M>,
  ): Promise<Results[M]> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        method,
        resolve: resolve as (result: unknown) => void,
        reject,
      });
      this.send({ id, method, params });
    });
  }

  onNotification(handler: (notification: Notification) => void): void {
    this.notified = handler;
  }

  onRequest(handler: (request: Request) => Promise<unknown>): void {
    this.asked = handler;
  }

  close(): void {
    this.input.end();
    this.stop();
  }

  private send(message: object): void {
    this.input.write(`${JSON.stringify(message)}\n`);
  }

  private read(line: string): void {
    let message: {
      id?: number | string;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { code: number; message: string };
    };
    try {
      message = JSON.parse(line);
    } catch {
      console.warn("Ignoring a line the app-server wrote", line.slice(0, 200));
      return;
    }
    if (message.method === undefined) {
      const request = this.pending.get(Number(message.id));
      if (request === undefined) {
        return;
      }
      this.pending.delete(Number(message.id));
      if (message.error) {
        request.reject(
          new RpcError(
            request.method,
            message.error.code,
            message.error.message,
          ),
        );
      } else {
        request.resolve(message.result);
      }
      return;
    }
    if (message.id === undefined) {
      this.notified(message as Notification);
      return;
    }
    const id = message.id;
    this.asked(message as Request).then(
      (result) => this.send({ id, result }),
      (error: unknown) =>
        this.send({ id, error: { code: -32603, message: String(error) } }),
    );
  }
}
