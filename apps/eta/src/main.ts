/**
 * The entry point: start the host.
 *
 *   bun apps/eta/src/main.ts [--port 8787] [--host 127.0.0.1]
 *                            [--web-dir <built web>] [--token-file <path>]
 *                            [--allow-origin <origin>]... [--memory-url <sidecar>] [--no-llm]
 *                            [--public-url <the address the browser uses>]
 *
 * A thin shell around `startHost`: flags, a startup summary on one line, and a signal handler.
 * Everything the host serves lives behind the one port; `--web-dir` adds the page, and a host
 * that listens beyond loopback (or is given a `--token-file`) asks for a token first.
 *
 * The data directory is `~/.eta` and is not a flag. A second one was a second half: personas went
 * on being read from the real home while the config came from somewhere else, so a process pointed
 * at another directory looked like a config that had gone missing. One root, `$HOME` decides it.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { startHost } from "./host";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "8787" },
    host: { type: "string", default: "127.0.0.1" },
    "web-dir": { type: "string" },
    "token-file": { type: "string" },
    "allow-origin": { type: "string", multiple: true },
    "memory-url": { type: "string" },
    "public-url": { type: "string" },
    "no-llm": { type: "boolean", default: false },
  },
  strict: true,
});

const port = Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  console.error(`--port: not a port: ${values.port}`);
  process.exit(2);
}

const memoryUrl = values["memory-url"] ?? process.env.ETA_MEMORY_URL;
const publicUrl = values["public-url"] ?? process.env.ETA_PUBLIC_URL;

const host = await startHost({
  dataDir: join(homedir(), ".eta"),
  port,
  hostname: values.host,
  ...(values["web-dir"] === undefined
    ? {}
    : { webDir: resolve(values["web-dir"]) }),
  ...(values["token-file"] === undefined
    ? {}
    : { tokenFile: resolve(values["token-file"]) }),
  allowOrigins: values["allow-origin"] ?? [],
  // Subscriptions and Gemini keys, through the in-process LLM gateway.
  llm: values["no-llm"] !== true,
  // The flag wins over the environment; an empty value means none.
  ...(memoryUrl === undefined || memoryUrl === "" ? {} : { memoryUrl }),
  ...(publicUrl === undefined || publicUrl === "" ? {} : { publicUrl }),
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
