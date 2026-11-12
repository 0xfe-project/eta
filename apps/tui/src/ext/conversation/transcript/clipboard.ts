import { Buffer } from "node:buffer";
import process from "node:process";

const ESC = "\u001B";
const BEL = "\u0007";

/**
 * Puts `text` on the clipboard of the terminal the TUI runs in, with an OSC 52 sequence written
 * to `write`. Inside tmux (`TMUX` set and not empty) the sequence goes through tmux's passthrough,
 * which tmux forwards to the outer terminal only when its `allow-passthrough` option is on.
 */
export function copyToClipboard(
  text: string,
  write: (data: string) => void = (data) => {
    process.stdout.write(data);
  },
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  const sequence = `${ESC}]52;c;${Buffer.from(text, "utf8").toString("base64")}${BEL}`;
  const insideTmux = env.TMUX !== undefined && env.TMUX !== "";
  write(
    insideTmux
      ? `${ESC}Ptmux;${sequence.replaceAll(ESC, ESC + ESC)}${ESC}\\`
      : sequence,
  );
}
