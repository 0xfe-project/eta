/** Reading what a short command prints, for the commands of `eta-host` the TUI runs and waits on. */

/** Reads a stream to its end, decoded, handing over each piece. Never throws. */
export async function collect(
  stream: ReadableStream<Uint8Array>,
  into: (text: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  try {
    for await (const chunk of stream)
      into(decoder.decode(chunk, { stream: true }));
  } catch {
    // The pipe of a killed command; what was read is kept.
  }
  into(decoder.decode());
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
