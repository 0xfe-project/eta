/**
 * An idle host with the gateway loaded keeps its event loop. The host is mostly idle: timers,
 * a request now and then, and the garbage collector running between them. With the flag Go's
 * runtime puts on JavaScriptCore's thread-suspend signal, the collector hung within seconds in
 * about a third to half of runs, and every timer stopped (see snapshotSignals in src/index.ts).
 *
 * Prints one JSON line: `{ ticks }`, the 100 ms ticks seen in `seconds`.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { startGateway } from "../../src/index";

const seconds = Number(process.argv[2] ?? 12);
const gateway = startGateway({
  stateDir: mkdtempSync(join(tmpdir(), "llm-gateway-")),
});

let ticks = 0;
const tick = setInterval(() => (ticks += 1), 100);
const collect = setInterval(() => Bun.gc(true), 400);
const poke = setInterval(() => {
  gateway
    .fetch("/v1/models")
    .then((response) => response.text())
    .catch(() => undefined);
}, 300);
setTimeout(() => {
  clearInterval(tick);
  clearInterval(collect);
  clearInterval(poke);
  gateway.stop();
  console.log(JSON.stringify({ ticks }));
  process.exit(0);
}, seconds * 1000);
