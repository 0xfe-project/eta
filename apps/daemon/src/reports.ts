/**
 * Telling the primary what happened to a question, even when it is not listening.
 *
 * A session on the daemon asks, is answered, or gives up, and the primary's inbox hears of each
 * through a notification (`ask.observe`). A notification is not retried, so one sent while the
 * link was down would never arrive, and a question the primary never heard of cannot be
 * answered. So a report that has nowhere to go waits here, in order, and goes out when a link is
 * attached again.
 */
import type { Peer } from "./link/peer";

/** The most reports kept for a link that is down: a link that never returns must not grow this forever. */
export const UNREPORTED_LIMIT = 256;

type Notifier = Pick<Peer, "lost" | "notify">;

export class Reports<Report> {
  readonly #method: string;
  readonly #warn: (message: string) => void;
  readonly #waiting: Report[] = [];
  #peer: Notifier | undefined;

  constructor(method: string, warn: (message: string) => void) {
    this.#method = method;
    this.#warn = warn;
  }

  /** Tell the primary now, or when the next link is attached. */
  send(report: Report): void {
    const peer = this.#peer;
    if (peer !== undefined && !peer.lost) {
      try {
        peer.notify(this.#method, report);
        return;
      } catch (error) {
        this.#warn(
          `[eta-daemon] could not send ${this.#method}: ${String(error)}`,
        );
      }
    }
    this.#waiting.push(report);
    if (this.#waiting.length > UNREPORTED_LIMIT) this.#waiting.shift();
  }

  /** A link came up: what waited goes out first, oldest first. */
  attach(peer: Notifier): void {
    this.#peer = peer;
    for (const report of this.#waiting.splice(0)) this.send(report);
  }

  /** The link went away; reports wait again. */
  detach(peer: Notifier): void {
    if (this.#peer === peer) this.#peer = undefined;
  }

  /** How many are waiting for a link. */
  get waiting(): number {
    return this.#waiting.length;
  }
}
