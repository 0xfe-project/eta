/**
 * Streaming under pressure: many concurrent streams through the gateway while this process
 * allocates and collects garbage as fast as it can. Go's runtime preempts its goroutines with
 * signals (SIGURG) while Bun's runs its own garbage collector and event loop in the same process;
 * this is the combination that would show a conflict as a crash, a hang or a torn stream.
 *
 * Prints one JSON line: `{ requests, bytes, torn }`. Exits non-zero on any failure.
 */
import process from "node:process";
import { chat, fakeUpstream, gatewayOn } from "../fake-upstream";

const seconds = Number(process.argv[2] ?? 10);
const upstream = fakeUpstream();
const gateway = await gatewayOn(upstream);

const until = Date.now() + seconds * 1000;
let requests = 0;
let bytes = 0;
let torn = 0;
let garbage: unknown[] = [];
while (Date.now() < until) {
  const batch = await Promise.all(
    Array.from({ length: 16 }, async () => {
      const { status, text } = await chat(gateway, "hi");
      // A stream that ended without its last event, or a failure, is a torn one.
      if (status !== 200 || !text.includes("[DONE]")) torn += 1;
      return text.length;
    }),
  );
  requests += batch.length;
  bytes += batch.reduce((sum, length) => sum + length, 0);
  for (let i = 0; i < 20_000; i++) garbage.push({ i, s: "y".repeat(32) });
  if (garbage.length > 400_000) {
    garbage = [];
    Bun.gc(true);
  }
}
gateway.stop();
upstream.stop();
console.log(JSON.stringify({ requests, bytes, torn }));
process.exit(torn === 0 && requests > 0 ? 0 : 1);
