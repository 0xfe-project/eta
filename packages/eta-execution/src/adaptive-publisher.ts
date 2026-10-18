/**
 * AdaptivePublisher — publish the latest state, never queue intermediate ones
 * (port of eta-agent's `harness/utils/adaptive-publisher.ts`).
 *
 * A command can print faster than anything upstream can consume. The rule here is
 * "newest wins": each publication buys a delay proportional to what it encoded,
 * floored at a minimum interval that also bounds the event count, and one trailing
 * timer guarantees the last state still goes out. The first dirty state after
 * idle is immediate, so a quiet command's first line is not delayed by a budget
 * it is nowhere near spending.
 */
export interface AdaptivePublisherOptions<TValue, TUpdate> {
  snapshot: () => TValue;
  update: (
    previous: TValue | undefined,
    current: TValue,
  ) => TUpdate | undefined;
  measure: (update: TUpdate) => number;
  publish: (update: TUpdate) => void;
  onError: (error: unknown) => void;
  minIntervalMs?: number | undefined;
  targetBytesPerSecond?: number | undefined;
}

export class AdaptivePublisher<TValue, TUpdate> {
  private readonly options: AdaptivePublisherOptions<TValue, TUpdate>;
  private readonly minIntervalMs: number;
  private readonly targetBytesPerSecond: number;
  private published: TValue | undefined;
  private dirty = false;
  private nextEmitAt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(options: AdaptivePublisherOptions<TValue, TUpdate>) {
    this.options = options;
    this.minIntervalMs = options.minIntervalMs ?? 100;
    this.targetBytesPerSecond = options.targetBytesPerSecond ?? 100 * 1024;
  }

  markDirty(): void {
    if (this.disposed) return;
    this.dirty = true;
    const wait = this.nextEmitAt - Date.now();
    if (wait <= 0) {
      this.flush();
      return;
    }
    this.armTimer(wait);
  }

  flush(force = false): void {
    if (this.disposed || !this.dirty) return;
    const now = Date.now();
    if (!force && now < this.nextEmitAt) {
      this.armTimer(this.nextEmitAt - now);
      return;
    }
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    const current = this.options.snapshot();
    const update = this.options.update(this.published, current);
    if (update === undefined) {
      this.published = current;
      this.dirty = false;
      return;
    }
    const encodedBytes = this.options.measure(update);
    this.published = current;
    this.dirty = false;
    this.nextEmitAt =
      now +
      Math.max(
        this.minIntervalMs,
        (encodedBytes * 1000) / this.targetBytesPerSecond,
      );
    // Commit before delivery. A consumer may apply the update and then throw or
    // reenter the producer; retaining the old baseline would duplicate that delta.
    this.options.publish(update);
  }

  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.disposed = true;
  }

  private armTimer(wait: number): void {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      try {
        this.flush();
      } catch (error) {
        this.options.onError(error);
      }
    }, wait);
  }
}
