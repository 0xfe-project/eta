/**
 * Talking to a test host outside the interface: a second real client for data a test needs on
 * the host before the interface connects, and a record of the calls the interface makes.
 */
import type { Host } from "@eta/app/src/host";
import type { WireClient } from "../../src/connection/types";
import { Wire } from "../../src/connection/wire";
import { until } from "../support/temp";

/** Opens a client on the host, runs `task` with it, and closes it again. */
export async function withHostWire<T>(
  host: Host,
  task: (wire: WireClient) => Promise<T>,
): Promise<T> {
  const wire = new Wire({ url: `ws://127.0.0.1:${host.port}/ws` });
  wire.connect();
  try {
    await until(
      () => wire.store.getState().status === "open",
      10_000,
      "a seeding client to connect",
    );
    return await task(wire);
  } finally {
    wire.close();
  }
}

export interface RecordedCall {
  target: string;
  action: string;
  args: unknown;
  /** The reply, once it came. */
  result?: unknown;
}

/** Records every call made on `wire` from now on, with its reply; the calls still go through. */
export function recordCalls(wire: WireClient): RecordedCall[] {
  const calls: RecordedCall[] = [];
  const call = wire.call.bind(wire);
  wire.call = async <T>(
    target: string,
    action: string,
    args?: unknown,
    options?: { timeoutMs?: number },
  ): Promise<T> => {
    const entry: RecordedCall = { target, action, args };
    calls.push(entry);
    const result = await call<T>(target, action, args, options);
    entry.result = result;
    return result;
  };
  return calls;
}
