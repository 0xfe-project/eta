/**
 * Reading an SSE body in a test.
 *
 * It remembers the read it started, because a timed-out read is still a read: asking again would
 * start a second one, and whichever resolved first would steal the frame.
 */
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface SseFrame {
  /** The `id:` line, which is the seq the server gave this event. */
  id: number;
  /** The `event:` name. */
  event: string;
  /** The `data:` payload, parsed. */
  data: unknown;
}

export interface SseReader {
  next: (timeoutMs?: number) => Promise<SseFrame | undefined>;
  /** Frames until `done` says stop, or the budget runs out. */
  until: (
    done: (frames: SseFrame[]) => boolean,
    timeoutMs?: number,
  ) => Promise<SseFrame[]>;
  cancel: () => Promise<void>;
}

export function sseReader(response: Response): SseReader {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const queue: SseFrame[] = [];
  let buffer = "";
  let inflight: ReturnType<typeof reader.read> | undefined;

  const parse = (block: string): SseFrame | undefined => {
    const id = block.match(/^id: (\d+)$/m)?.[1];
    const event = block.match(/^event: (.*)$/m)?.[1];
    const data = block.match(/^data: (.*)$/m)?.[1];
    if (id === undefined || event === undefined || data === undefined)
      return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      parsed = data;
    }
    return { id: Number(id), event, data: parsed };
  };

  return {
    async next(timeoutMs = 1_000) {
      const deadline = Date.now() + timeoutMs;
      while (queue.length === 0) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return undefined;
        inflight ??= reader.read();
        const chunk = await Promise.race([
          inflight,
          sleep(remaining).then(() => null),
        ]);
        if (chunk === null) return undefined;
        inflight = undefined;
        if (chunk.done) return undefined;
        buffer += decoder.decode(chunk.value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          if (part.trim().length === 0 || part.startsWith(":")) continue;
          const frame = parse(part);
          if (frame !== undefined) queue.push(frame);
        }
      }
      return queue.shift();
    },
    async until(done, timeoutMs = 2_000) {
      const frames: SseFrame[] = [];
      const deadline = Date.now() + timeoutMs;
      while (!done(frames) && Date.now() < deadline) {
        const frame = await this.next(deadline - Date.now());
        if (frame === undefined) break;
        frames.push(frame);
      }
      return frames;
    },
    async cancel() {
      await reader.cancel().catch(() => undefined);
    },
  };
}
