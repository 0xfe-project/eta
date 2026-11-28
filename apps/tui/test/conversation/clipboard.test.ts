/** OSC 52: the bytes written to put text on the terminal's clipboard. */
import process from "node:process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyToClipboard } from "../../src/ext/conversation/transcript/clipboard";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function written(text: string, tmux: string): string {
  vi.stubEnv("TMUX", tmux);
  const out: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((data) => {
    out.push(String(data));
    return true;
  });
  copyToClipboard(text);
  expect(out).toHaveLength(1);
  return out[0]!;
}

describe("copyToClipboard", () => {
  it("encodes the text as UTF-8", () => {
    // "你好" is e4 bd a0 e5 a5 bd in UTF-8.
    expect(written("你好", "")).toBe("\u001B]52;c;5L2g5aW9\u0007");
  });

  it("wraps the sequence for tmux when TMUX is set, doubling its ESC", () => {
    expect(written("hi", "/tmp/tmux-1/default,1,0")).toBe(
      "\u001BPtmux;\u001B\u001B]52;c;aGk=\u0007\u001B\\",
    );
  });
});
