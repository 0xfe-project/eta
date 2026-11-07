/**
 * How a process is told to stop where there are no signals. Windows has no SIGTERM: what ends a
 * process from outside there ends it on the spot. So the service shell (`apps/eta/service-shell`)
 * makes up a name for a pipe, says it in `ETA_STOP_PIPE`, and this listens: a line on it is a
 * SIGTERM, and the handlers that already exist for one do the rest. Only the shell knows the name,
 * and out of the environment it goes, or everything the host starts would.
 *
 * Elsewhere, or by hand, the variable is not there and this does nothing.
 */
import { createServer } from "node:net";
import process from "node:process";

export function listenForStop(env: NodeJS.ProcessEnv = process.env): void {
  const pipe = env.ETA_STOP_PIPE;
  if (pipe === undefined || pipe === "") return;
  delete env.ETA_STOP_PIPE;
  const server = createServer((socket) => {
    socket.on("data", () => {
      // With nothing to handle it a signal would end the process, so that is what this does too.
      if (process.listenerCount("SIGTERM") === 0) process.exit(143);
      process.emit("SIGTERM", "SIGTERM");
    });
    socket.on("error", () => undefined);
  });
  server.unref();
  server.listen(pipe);
}
