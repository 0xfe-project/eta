import process from "node:process";

/**
 * Returns whether the current environment represents CI (`process.env.CI` set
 * to a truthy value other than `""`, `"0"`, or `"false"`).
 */
export function isCiEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.CI;
  if (raw === undefined) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false";
}

/**
 * Default `-j` worker count for `nsh test`.
 *
 * Each test file runs on its own QuickJS engine, and `nsh-testing` hardcodes a
 * 5 s `WAIT` budget for first render (`crates/nsh-testing/src/headless/mod.rs`).
 * On CI runners (2-4 cores) where Turbo runs sibling tasks concurrently, `-j 2`
 * oversubscribes CPU during cold starts and pushes first render past 5 s.
 * Run serially (`-j 1`) on CI while keeping `-j 2` on local developer machines.
 */
export function defaultClientTestJobs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return isCiEnvironment(env) ? 1 : 2;
}

/**
 * Derives the `nsh` CLI argument list for `scripts/nsh-client.ts`, injecting
 * `-j <jobs>` immediately after `test` when no job count or help flag is given.
 */
export function resolveNshClientArgs(
  rawArgs: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (rawArgs[0] !== "test") return [...rawArgs];
  const separator = rawArgs.indexOf("--");
  const flagArgs =
    separator === -1 ? rawArgs.slice(1) : rawArgs.slice(1, separator);
  if (flagArgs.includes("--help") || flagArgs.includes("-h")) {
    return [...rawArgs];
  }
  const jobsGiven = flagArgs.some(
    (arg) =>
      arg === "-j" ||
      arg === "--jobs" ||
      arg.startsWith("--jobs=") ||
      /^-j.+/.test(arg),
  );
  if (jobsGiven) return [...rawArgs];
  return [
    "test",
    "-j",
    String(defaultClientTestJobs(env)),
    ...rawArgs.slice(1),
  ];
}
