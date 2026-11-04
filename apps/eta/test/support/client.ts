/** A wire client for tests: a real WebSocket, and the frames it has received. */
import type { ServerFrame } from "@eta/client-contracts";
import type { ClientFrame } from "@eta/client-wire-proto";

export interface Client {
  frames: ServerFrame[];
  hello: () => Promise<Extract<ServerFrame, { type: "hello" }>>;
  call: (target: string, action: string, args?: unknown) => Promise<unknown>;
  subscribe: (target: string) => void;
  unsubscribe: (target: string) => void;
  /** A section of a target's state as the frames have left it (from `hello` or a subscription). */
  section: <T>(target: string, name: string) => T | undefined;
  close: () => void;
}

export async function until(
  predicate: () => boolean | Promise<boolean>,
  // Long enough for a loaded machine (every package's tests run at once); a wait that is
  // going to succeed does not wait for it.
  timeoutMs = 15_000,
): Promise<void> {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("timed out waiting for the frames");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Open a socket; rejects with what the handshake answered when the server refuses it. */
export function connect(
  url: string,
  headers: Record<string, string> = {},
): Promise<Client> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    const frames: ServerFrame[] = [];
    /** What a client that keeps state would hold: each target's sections, patches merged in. */
    const states = new Map<string, Record<string, unknown>>();
    const pending = new Map<
      string,
      { resolve: (value: unknown) => void; reject: (error: Error) => void }
    >();
    let nextId = 1;
    socket.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as ServerFrame;
      frames.push(frame);
      if (frame.type === "hello") {
        for (const [target, snapshot] of Object.entries(frame.state))
          states.set(target, { ...snapshot.sections });
      } else if (frame.type === "state") {
        if (frame.snapshot !== undefined)
          states.set(frame.target, { ...frame.snapshot.sections });
        else if (frame.patch !== undefined)
          states.set(frame.target, {
            ...states.get(frame.target),
            ...frame.patch.sections,
          });
      }
      if (frame.type !== "reply") return;
      const waiter = pending.get(frame.requestId);
      if (waiter === undefined) return;
      pending.delete(frame.requestId);
      if (frame.ok) waiter.resolve(frame.result);
      else
        waiter.reject(
          Object.assign(new Error(frame.error), { problem: frame.problem }),
        );
    });
    socket.addEventListener("error", () =>
      reject(new Error("the socket could not connect")),
    );
    socket.addEventListener("open", () => {
      const send = (frame: ClientFrame): void =>
        socket.send(JSON.stringify(frame));
      resolve({
        frames,
        async hello() {
          await until(() => frames.some((frame) => frame.type === "hello"));
          return frames.find((frame) => frame.type === "hello") as Extract<
            ServerFrame,
            { type: "hello" }
          >;
        },
        call(target, action, args) {
          const requestId = `r${nextId++}`;
          send({
            op: "call",
            target,
            action,
            ...(args === undefined ? {} : { args }),
            requestId,
          });
          return new Promise((res, rej) =>
            pending.set(requestId, { resolve: res, reject: rej }),
          );
        },
        subscribe(target) {
          send({ op: "subscribe", target });
        },
        unsubscribe(target) {
          send({ op: "unsubscribe", target });
        },
        section<T>(target: string, name: string): T | undefined {
          return states.get(target)?.[name] as T | undefined;
        },
        close() {
          socket.close();
        },
      });
    });
  });
}
