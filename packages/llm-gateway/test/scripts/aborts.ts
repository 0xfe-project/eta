/**
 * Clients that hang up mid-stream. The Go side then writes into closed sockets (EPIPE, and the
 * SIGPIPE the Go runtime keeps for itself), and the gateway must cancel the upstream request and
 * go on serving. Afterwards a fresh request has to complete, and the fake upstream has to have
 * seen the streams cancelled.
 *
 * Prints one JSON line: `{ aborted, cancelled, after }`. Exits non-zero on any failure.
 */
import process from "node:process";
import { chat, fakeUpstream, gatewayOn } from "../fake-upstream";

const rounds = Number(process.argv[2] ?? 100);
const upstream = fakeUpstream();
const gateway = await gatewayOn(upstream);

let aborted = 0;
for (let round = 0; round < rounds; round++) {
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      const control = new AbortController();
      try {
        const response = await gateway.fetch("/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "gpt-test",
            stream: true,
            messages: [{ role: "user", content: "slow" }],
          }),
          signal: control.signal,
        });
        const reader = response.body!.getReader();
        await reader.read();
        control.abort();
        aborted += 1;
      } catch {
        // An abort that lands before the first byte is not a mid-stream one.
      }
    }),
  );
}

// The upstream notices a hang-up a moment later.
const deadline = Date.now() + 15_000;
while (upstream.cancelled < aborted && Date.now() < deadline)
  await Bun.sleep(50);

const after = await chat(gateway, "hi");
const cancelled = upstream.cancelled;
gateway.stop();
upstream.stop();
console.log(JSON.stringify({ aborted, cancelled, after: after.status }));
process.exit(
  aborted > 0 && cancelled >= aborted && after.status === 200 ? 0 : 1,
);
