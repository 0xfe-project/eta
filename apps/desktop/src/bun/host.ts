/**
 * The script the shell writes out and runs under bun, ahead of the host.
 *
 * It is a string because nothing else survives the bundle: a file import is inlined, and
 * `build.copy` does not land files in the dev bundle. The Electrobun launcher owns the shell's
 * stdout, so the shell cannot read the host's summary off a pipe; this script keeps the host's
 * first stdout line — its JSON summary (`apps/eta/src/main.ts`) — in the file named by
 * `ETA_DESKTOP_SUMMARY` and forwards the rest.
 *
 * It also keeps the host from outliving the shell. A shell that is killed outright sends nothing,
 * and a host left behind holds the database and the port the next launch wants, so this looks for
 * the shell every second and stops the host once it has gone. Stopping is a signal, or on Windows,
 * which has none, a line on the pipe the host listens to (`ETA_STOP_PIPE`, `apps/eta/src/stop.ts`).
 */
export const HOST_WRAPPER = String.raw`const summary = process.env.ETA_DESKTOP_SUMMARY;
if (summary === undefined) {
  console.error("ETA_DESKTOP_SUMMARY is not set");
  process.exit(1);
}

const child = Bun.spawn(process.argv.slice(2), {
  stdin: "inherit",
  stdout: "pipe",
  stderr: "inherit",
});

const stopPipe = process.env.ETA_STOP_PIPE;
const stopHost = (signal = "SIGTERM") => {
  if (stopPipe === undefined || stopPipe === "") {
    child.kill(signal);
    return;
  }
  const net = require("node:net");
  const socket = net.connect(stopPipe, () => socket.end("stop\n"));
  socket.on("error", () => child.kill(signal));
};

// The shell's signal stops this script, and the host has to hear it: left running, it would still
// hold the database when the shell starts another one.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => stopHost(signal));
}

const shell = process.ppid;
const watching = setInterval(() => {
  try {
    process.kill(shell, 0);
  } catch {
    clearInterval(watching);
    stopHost();
  }
}, 1000);
watching.unref();

const reader = child.stdout.getReader();
const decoder = new TextDecoder();
let buffer = "";
for (;;) {
  const { value, done } = await reader.read();
  if (done) {
    console.error("the host exited before it was ready");
    process.exit(1);
  }
  buffer += decoder.decode(value);
  const end = buffer.indexOf("\n");
  if (end === -1) continue;
  await Bun.write(summary, buffer.slice(0, end + 1));
  process.stdout.write(buffer.slice(end + 1));
  break;
}

for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  process.stdout.write(decoder.decode(value));
}

process.exit(await child.exited);
`;
