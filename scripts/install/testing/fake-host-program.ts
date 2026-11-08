/**
 * The source of a fake eta-host for Windows, compiled by `windows-exe.ts` with `--define`:
 *
 * - `--version` prints `eta-host <FAKE_VERSION> (37d8188c1234)` on stdout. `FAKE_MODE` changes it:
 *   - "tamper": first appends a byte to each `eta-*` file beside it that is not an eta-host;
 *   - "location": adds `-moved` to the version when it runs from a `.eta` directory;
 *   - "record": first appends the directory it runs from to `%USERPROFILE%\seen`;
 *   - "stderr": prints the line on stderr instead, and nothing on stdout.
 * - `--hold` keeps running until it is killed, which keeps its file in use.
 */
import { appendFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";

declare const FAKE_VERSION: string;
declare const FAKE_MODE: string;

const command = process.argv.slice(2)[0];

if (command === "--hold") {
  setInterval(() => {}, 60_000);
} else if (command === "--version") {
  const here = dirname(process.execPath);
  if (FAKE_MODE === "tamper") {
    for (const name of readdirSync(here)) {
      if (name.startsWith("eta-") && !name.startsWith("eta-host"))
        appendFileSync(join(here, name), "x");
    }
  }
  if (FAKE_MODE === "record")
    appendFileSync(join(process.env.USERPROFILE ?? here, "seen"), `${here}\n`);
  const moved = FAKE_MODE === "location" && here.includes(".eta");
  const line = `eta-host ${FAKE_VERSION}${moved ? "-moved" : ""} (37d8188c1234)\n`;
  if (FAKE_MODE === "stderr") process.stderr.write(line);
  else process.stdout.write(line);
} else {
  process.exit(3);
}
