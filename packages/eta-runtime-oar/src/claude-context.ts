import type { RawEvent } from "@botiverse/oar";

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function resultReading(
  result: Record<string, unknown>,
  model: string,
): { used: number; window: number } | undefined {
  if (result.subtype !== "success" || result.num_turns !== 1) return;
  // The native result.usage covers this turn's main loop. OAR's usage.tokens
  // folds results into a running total, and its input already includes cache.
  const usage = object(result.usage);
  const input = count(usage?.input_tokens);
  const read = count(usage?.cache_read_input_tokens);
  const write = count(usage?.cache_creation_input_tokens);
  if (input === undefined || read === undefined || write === undefined) return;
  const modelUsage = object(object(result.modelUsage)?.[model]);
  const window = count(modelUsage?.contextWindow);
  const used = input + read + write;
  if (
    window === undefined ||
    !Number.isSafeInteger(used) ||
    used <= 0 ||
    used > window
  )
    return;
  return { used, window };
}

/** Evidence from the root Claude turn, kept only until its projected result is delivered. */
export class ClaudeTurnContext {
  #model: string | undefined;
  #crossedBoundary = false;
  #result:
    | {
        seq: number;
        model: string | undefined;
        reading: ReturnType<typeof resultReading>;
      }
    | undefined;

  see(record: RawEvent): void {
    if (record.kind !== "frame" || record.agentPath.length > 0) return;
    if (
      record.body.events.some(
        (event) =>
          event.kind === "tool_call_started" ||
          event.kind === "compaction_started" ||
          event.kind === "compaction_ended",
      )
    ) {
      this.#crossedBoundary = true;
    }
    const frame = object(record.body.native);
    if (frame?.type === "assistant") {
      const model = object(frame.message)?.model;
      if (
        typeof model === "string" &&
        model.length > 0 &&
        model !== "<synthetic>"
      ) {
        if (this.#model !== undefined && this.#model !== model)
          this.#crossedBoundary = true;
        this.#model = model;
      }
    } else if (frame?.type === "result") {
      const model = this.#model;
      this.#result = {
        seq: record.seq,
        model,
        reading:
          model !== undefined && !this.#crossedBoundary
            ? resultReading(frame, model)
            : undefined,
      };
      this.#model = undefined;
      this.#crossedBoundary = false;
    }
  }

  reset(): void {
    this.#model = undefined;
    this.#crossedBoundary = false;
    this.#result = undefined;
  }

  result(seq: number) {
    return this.#result?.seq === seq ? this.#result : undefined;
  }
}
