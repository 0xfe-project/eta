/**
 * Uninstalls the service and installs it again at once, round after round, the way every scenario
 * of `drive.ts` starts (`reset`). Each install reads expected Windows error codes, 1060 and 1062,
 * and on main about one in 125 lost one to a 0 and failed with `io.eta.host: Windows error 0`
 * (#367). Each round's install is tallied by its exit and its error, so a run says how often it
 * failed and with what.
 *
 *   bun scripts/upgrade-e2e/reinstall-loop.ts <eta-host.exe> <rounds> [label] [absent]
 *
 * With `absent` it installs nothing, and runs `uninstall-service` with nothing installed instead:
 * each run asks Windows for both services and must be told 1060, "no such service", which is the
 * code every fresh install has to read correctly too.
 *
 * Windows only, in an Administrator's terminal, with ETA_E2E_PASSWORD the password of this
 * account, on a computer nobody uses: it owns `io.eta.host`, `~/.eta` and `~/eta-e2e` there. The
 * tally is appended to `reinstall-loop.jsonl`, a line a round.
 */
import type { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

const SOURCE = resolve(process.argv[2] ?? "eta-host.exe");
const ROUNDS = Number(process.argv[3] ?? 40);
const LABEL = process.argv[4] ?? "";
const ABSENT = process.argv[5] === "absent";
const HOME = homedir();
const DIR = join(HOME, "eta-e2e");
const EXE = join(DIR, "eta-host.exe");
const DATA = join(HOME, ".eta");
const PORT = 18_790;
const OUT = resolve("reinstall-loop.jsonl");

interface Ran {
  code: number;
  out: string;
  ms: number;
}

function run(file: string, args: string[], input = ""): Promise<Ran> {
  const started = Date.now();
  return new Promise((done, reject) => {
    const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      done({ code: code ?? 1, out: out.trim(), ms: Date.now() - started }),
    );
    child.stdin.end(input);
  });
}

async function up(): Promise<boolean> {
  try {
    const answer = await fetch(`http://127.0.0.1:${PORT}/up`, {
      signal: AbortSignal.timeout(3000),
    });
    return answer.ok;
  } catch {
    return false;
  }
}

async function waitUp(seconds: number): Promise<boolean> {
  for (const until = Date.now() + seconds * 1000; Date.now() < until; ) {
    if (await up()) return true;
    await sleep(250);
  }
  return false;
}

/** As drive.ts's `clean`: the folder may be held for a moment after what ran from it exits. */
async function removeDir(): Promise<void> {
  for (const until = Date.now() + 60_000; ; ) {
    try {
      rmSync(DIR, { recursive: true, force: true });
      return;
    } catch (error) {
      if (Date.now() > until) throw error;
      await sleep(250);
    }
  }
}

const install = (): Promise<Ran> => {
  mkdirSync(DIR, { recursive: true });
  copyFileSync(SOURCE, EXE);
  return run(
    EXE,
    ["install-service", "--port", String(PORT), "--no-web", "--no-llm"],
    `${process.env.ETA_E2E_PASSWORD ?? ""}\n`,
  );
};

const tally = new Map<string, number>();
let failed = 0;

if (ABSENT) {
  mkdirSync(DIR, { recursive: true });
  copyFileSync(SOURCE, EXE);
  await run(EXE, ["uninstall-service"]);
  for (let round = 1; round <= ROUNDS; round += 1) {
    const ran = await run(EXE, ["uninstall-service"]);
    const error =
      ran.code === 0
        ? "ok"
        : (/uninstall-service: (.*)$/m.exec(ran.out)?.[1] ?? ran.out);
    if (error !== "ok") {
      failed += 1;
      console.log(`${LABEL} round ${round}: ${error}`);
    }
    tally.set(error, (tally.get(error) ?? 0) + 1);
    appendFileSync(
      OUT,
      `${JSON.stringify({ label: LABEL, mode: "absent", round, code: ran.code, ms: ran.ms, out: ran.out })}\n`,
    );
  }
}

for (let round = 1; round <= (ABSENT ? 0 : ROUNDS); round += 1) {
  const uninstalled = existsSync(EXE)
    ? await run(EXE, ["uninstall-service"])
    : undefined;
  await removeDir();
  rmSync(DATA, { recursive: true, force: true });
  const installed = await install();
  const answered = installed.code === 0 && (await waitUp(120));
  // What drive.ts asks between scenarios, by the system's own tool.
  const query = await run("sc.exe", ["query", "io.eta.host"]);
  const error =
    installed.code === 0
      ? answered
        ? "ok"
        : "installed, never answered"
      : (/install-service: (.*)$/m.exec(installed.out)?.[1] ?? installed.out);
  if (error !== "ok") failed += 1;
  tally.set(error, (tally.get(error) ?? 0) + 1);
  const line = {
    label: LABEL,
    round,
    uninstall: uninstalled && {
      code: uninstalled.code,
      ms: uninstalled.ms,
      out: uninstalled.out,
    },
    install: { code: installed.code, ms: installed.ms, out: installed.out },
    answered,
    sc: query.out.replace(/\s+/g, " "),
  };
  appendFileSync(OUT, `${JSON.stringify(line)}\n`);
  console.log(
    `${LABEL} round ${round}: ${error} (uninstall ${uninstalled?.ms ?? 0} ms, install ${installed.ms} ms)`,
  );
  if (error !== "ok") console.log(installed.out.replace(/^/gm, "    | "));
}

if (existsSync(EXE)) await run(EXE, ["uninstall-service"]);
const what = ABSENT ? "uninstalls of nothing" : "reinstalls";
console.log(`\n${LABEL}: ${failed} of ${ROUNDS} ${what} failed`);
for (const [error, count] of tally) console.log(`  ${count}× ${error}`);
if (process.env.GITHUB_STEP_SUMMARY !== undefined)
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `### ${LABEL}: ${failed} of ${ROUNDS} ${what} failed\n\n${[...tally]
      .map(([error, count]) => `- ${count}× \`${error}\``)
      .join("\n")}\n\n`,
  );
process.exitCode = failed === 0 ? 0 : 1;
