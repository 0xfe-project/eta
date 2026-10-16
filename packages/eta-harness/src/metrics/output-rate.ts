/**
 * Output tokens/sec for the run in progress.
 *
 * One scale: "tokens this run has produced", committed plus the in-flight
 * message's share of it. That is the whole reason this lives in one place — the
 * two feeds it has differ by orders of magnitude if you let them. `usage` events
 * carry the *session* total, while a streaming frame can only see the one
 * message being written. Sampling both into the same counter makes each commit
 * look like a jump of everything the session ever emitted, and the readout lands
 * in the tens of thousands of tok/s.
 */

const WINDOW_MS = 2_000;
const MIN_SPAN_SECONDS = 0.5;

export class OutputRate {
  private readonly samples: { out: number; at: number }[] = [];
  private committed = 0;
  private rate = 0;

  /** 0 until the run has produced samples spanning at least MIN_SPAN_SECONDS. */
  get value(): number {
    return this.rate;
  }

  /** A message committed: fold in the output its provider reported. */
  commit(messageOut: number): void {
    this.committed += messageOut > 0 ? messageOut : 0;
    this.sample(this.committed);
  }

  /** One stream frame: the in-flight message's output so far, above what is committed. */
  inFlight(inFlightOut: number): void {
    this.sample(this.committed + (inFlightOut > 0 ? inFlightOut : 0));
  }

  /** New run: nothing has been produced yet, so the window and the base both start over. */
  reset(): void {
    this.samples.length = 0;
    this.committed = 0;
    this.rate = 0;
  }

  private sample(total: number): void {
    const now = Date.now();
    const samples = this.samples;
    if (samples.length === 0) {
      samples.push({ out: total, at: now });
      return;
    }
    const last = samples[samples.length - 1]!;
    if (total < last.out) {
      // A chars/3 estimate overshooting the provider's real count dips the series
      // the moment that message commits. Shift the window down by the dip: the
      // correction is estimate error rather than tokens produced, and discarding
      // the window instead would freeze the readout at whatever rate came before.
      const dip = last.out - total;
      for (const sample of samples) sample.out = Math.max(0, sample.out - dip);
      return;
    }
    if (total === last.out) return;
    samples.push({ out: total, at: now });
    while (samples.length > 2 && now - samples[0]!.at > WINDOW_MS)
      samples.shift();
    const first = samples[0]!;
    const seconds = (now - first.at) / 1_000;
    if (seconds >= MIN_SPAN_SECONDS) this.rate = (total - first.out) / seconds;
  }
}
