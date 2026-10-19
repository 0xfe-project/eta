// Starts the agenvo relay for eta: writes its config for this run (loopback, the port eta chose,
// state in the bundle's data directory) and becomes `agenvo-server serve`. The relay's admin
// secret is AGENVO_ADMIN_SECRET, which eta gives this process from the bundle's config.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const port = Number(process.env.PORT);
const data = process.env.ETA_BUNDLE_DATA;
if (!Number.isInteger(port) || data === undefined) {
  console.error("PORT and ETA_BUNDLE_DATA are given by eta");
  process.exit(1);
}
mkdirSync(data, { recursive: true });
const config = join(data, "relay.json");
writeFileSync(
  config,
  JSON.stringify({
    baseUrl: `http://127.0.0.1:${port}`,
    dataDir: join(data, "state"),
    host: "127.0.0.1",
    port,
    trustedProxy: false,
  }),
);
const child = spawn("agenvo-server", ["serve", "--config", config], {
  stdio: ["ignore", "inherit", "inherit"],
  env: process.env,
});
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => child.kill(signal));
child.on("exit", (code) => process.exit(code ?? 1));
