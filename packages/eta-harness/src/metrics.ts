/**
 * MetricsService — the observable numbers, computed from the bus (REFACTOR.md
 * §2.4, and the answer to "observability board" in the original brief).
 *
 * The runner emits what happens — frames while a message streams, the settled
 * message when it lands, a run start — and this service turns that into the
 * numbers a dashboard shows. Nothing here is a seam the loop has to feed: a
 * subscriber that fails or is absent cannot slow a turn down.
 *
 * It lives in the harness: the numbers are not something the floor has an
 * opinion about, and the kernel ships no services beyond its primitives.
 *
 * `tokensPerSec` uses OutputRate's one scale: what this run has produced, the
 * committed count plus the in-flight message's share of it. The two feeds
 * differ by orders of magnitude if you mix them — the usage event carries the
 * session total while a frame can only see the message being written — which is
 * exactly the bug the class was written to prevent.
 */

import type { Context } from "cordis";
import { kernelOn } from "@eta/core";
import { Service } from "cordis";
import { OutputRate } from "./metrics/output-rate";

export class MetricsService extends Service {
  static readonly provide = "metrics";

  private readonly rate = new OutputRate();
  private readonly offs: (() => boolean)[] = [];

  constructor(ctx: Context) {
    super(ctx, "metrics");
    const on = kernelOn(ctx);
    this.offs.push(
      on("turn:run-start", () => {
        // A new run starts the window over: nothing has been produced yet.
        this.rate.reset();
      }),
      on("message:update", (event) => {
        // One frame: the in-flight message's output so far, above what is
        // already committed.
        const output = (event.message as { usage?: { output?: number } }).usage
          ?.output;
        if (output !== undefined) this.rate.inFlight(output);
      }),
      on("message:end", (event) => {
        // A settled assistant message: fold in the output the provider reported.
        if (event.message.role !== "assistant") return;
        const output =
          (event.message as { usage?: { output?: number } }).usage?.output ?? 0;
        this.rate.commit(output);
      }),
    );
  }

  /** Output tokens/sec for the run in progress. */
  get tokensPerSec(): number {
    return this.rate.value;
  }

  /** Stop measuring (a host that takes a session over). */
  stop(): void {
    for (const off of this.offs.splice(0)) off();
  }
}
