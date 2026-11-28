import { Buffer } from "node:buffer";
import process from "node:process";
import { vi } from "vitest";

// eslint-disable-next-line no-control-regex
const OSC52 = /\u001B\]52;c;([^\u0007]*)\u0007/g;

/**
 * The texts put on the terminal's clipboard from now on: the OSC 52 sequences written to stdout,
 * decoded, outside tmux. Nothing reaches the real stdout meanwhile. Undo with
 * `vi.restoreAllMocks()` and `vi.unstubAllEnvs()`.
 */
export function clipboardCopies(): string[] {
  vi.stubEnv("TMUX", "");
  const copies: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((data) => {
    for (const [, base64] of String(data).matchAll(OSC52))
      copies.push(Buffer.from(base64!, "base64").toString("utf8"));
    return true;
  });
  return copies;
}
