/** The stop channel over a real socket, which is what a Windows named pipe is to this code. */
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listenForStop } from "../src/stop";

const handlers: (() => void)[] = [];
afterEach(() => {
  for (const handler of handlers.splice(0)) process.off("SIGTERM", handler);
});

const send = (path: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const socket = connect(path, () => {
      socket.write("stop\n", () => {
        socket.end();
        resolve();
      });
    });
    socket.on("error", reject);
  });

describe("the stop channel", () => {
  it("is a SIGTERM to whoever handles one, and leaves the environment", async () => {
    const path = join(tmpdir(), `eta-stop-${process.pid}.sock`);
    const env: NodeJS.ProcessEnv = { ETA_STOP_PIPE: path };
    const stopped = new Promise<void>((resolve) => {
      const handler = () => resolve();
      handlers.push(handler);
      process.on("SIGTERM", handler);
    });
    listenForStop(env);
    expect(env.ETA_STOP_PIPE).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await send(path);
    await stopped;
  });

  it("is not there unless a service shell asked for it", () => {
    const env: NodeJS.ProcessEnv = {};
    listenForStop(env);
    expect(env).toEqual({});
  });
});
