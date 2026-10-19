/** A wire client for tests: a real WebSocket, and the frames it has received. */
import type { ServerFrame } from "@eta/client-contracts";
import type { ClientFrame } from "@eta/client-wire-proto";

export interface Client {
  frames: ServerFrame[];
  hello: () => Promise<Extract<ServerFrame, { type: "hello" }>>;
  call: (target: string, action: string, args?: unknown) => Promise<unknown>;
  subscribe: (target: string) => void;
  close: () => void;
}

export async function until(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
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
    const pending = new Map<
      string,
      { resolve: (value: unknown) => void; reject: (error: Error) => void }
    >();
    let nextId = 1;
    socket.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as ServerFrame;
      frames.push(frame);
      if (frame.type !== "reply") return;
      const waiter = pending.get(frame.requestId);
      if (waiter === undefined) return;
      pending.delete(frame.requestId);
      if (frame.ok) waiter.resolve(frame.result);
      else waiter.reject(new Error(frame.error));
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
        close() {
          socket.close();
        },
      });
    });
  });
}
