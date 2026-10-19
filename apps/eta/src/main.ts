/**
 * The entry point: start the host.
 *
 *   bun apps/eta/src/main.ts [--data-dir ~/.eta] [--port 8787] [--host 127.0.0.1]
 *                            [--web-dir <built web>] [--token-file <path>]
 *                            [--allow-origin <origin>]...
 *
 * A thin shell around `startHost`: flags, a startup summary on one line, and a signal handler.
 * Everything the host serves lives behind the one port; `--web-dir` adds the page, and a host
 * that listens beyond loopback (or is given a `--token-file`) asks for a token first.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { startHost } from "./host";

const { values } = parseArgs({
  options: {
    "data-dir": { type: "string" },
    port: { type: "string", default: "8787" },
    host: { type: "string", default: "127.0.0.1" },
    "web-dir": { type: "string" },
    "token-file": { type: "string" },
    "allow-origin": { type: "string", multiple: true },
  },
  strict: true,
});

const port = Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  console.error(`--port: not a port: ${values.port}`);
  process.exit(2);
}

const host = await startHost({
  dataDir: resolve(values["data-dir"] ?? join(homedir(), ".eta")),
  port,
  hostname: values.host,
  ...(values["web-dir"] === undefined
    ? {}
    : { webDir: resolve(values["web-dir"]) }),
  ...(values["token-file"] === undefined
    ? {}
    : { tokenFile: resolve(values["token-file"]) }),
  allowOrigins: values["allow-origin"] ?? [],
});

console.log(
  JSON.stringify({
    pid: process.pid,
    host: host.hostname,
    port: host.port,
    dataDir: host.dataDir,
    webDir: host.webDir ?? null,
    tokenFile: host.tokenFile ?? null,
    plugins: host.server
      .mounted()
      .map((plugin) =>
        plugin.error === undefined
          ? plugin.name
          : `${plugin.name} (${plugin.error})`,
      ),
  }),
);

/** A signal is a shutdown, not a crash: the sessions flush, the files close. */
let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    void host.close().then(() => process.exit(0));
  });
}
