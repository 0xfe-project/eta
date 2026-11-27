/**
 * The upgrade on this computer's real service manager, from a build to a build, against
 * `fake-releases.ts`. What each step checks is what a person would: the file, the service, `/up`,
 * the data. It asks the manager with the system's own tools, not with what is being tested.
 *
 *   bun scripts/upgrade-e2e/drive.ts <builds> [scenario...]
 *
 * With ETA_E2E_FROM and ETA_E2E_TO it runs the upgrade between two real releases instead, over the
 * seed `chooseSeed` picks: `<builds>/<version>/` holds each, and `<builds>/99.0.0/` a build that
 * cannot hold (`bad-host.ts`), a release only while its own scenario runs. ETA_E2E_REAL=1 takes
 * the upgrade from the build's real upstream, with whatever token it finds, instead of
 * `fake-releases.ts`; there is no bad build there.
 *
 * Two workflows run it, and they prove different things:
 *
 * - `upgrade-e2e.yml` ("Upgrade end to end"), the `upgrade` jobs on a pull request: SCENARIOS,
 *   between the 0.9.x hosts `build.ts` makes from the pull request's own code. It proves the
 *   machinery (swap, restart, migration, backup, rollback, the button, `--cancel`) on launchd and a
 *   Windows service. It is NOT a test across versions: no published build, no seed, no release
 *   candidate, no Linux. A green check there says nothing about data coming through from the last
 *   release.
 * - `upgrade-cross.yml` ("Upgrade across versions"): CROSS, ETA_E2E_FROM to ETA_E2E_TO, two
 *   published releases with the seed. release.yml runs it on Linux before publishing; for a change
 *   to the upgrade or a migration, run it by hand against the branch:
 *
 *     gh workflow run upgrade-cross.yml --ref <branch> -f from=0.3.0 -f to=<latest rc> -f platforms=linux
 *
 *   Its runs are not among the pull request's checks: `gh run list --workflow upgrade-cross.yml`.
 *
 * It runs as a user with a real home and a GUI session or a service logon, and it owns `~/.eta`
 * there: not for a computer anyone uses. On Windows it needs an Administrator's terminal and
 * ETA_E2E_PASSWORD, the password of this account.
 */
import type { Buffer } from "node:buffer";
import type { Check } from "./button";
import { spawn } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { Database } from "bun:sqlite";
import { connect, until } from "../../apps/eta/test/support/client";
import { hasPrereleaseSwitch } from "./button";
import {
  chooseSeed,
  MODEL_PORT,
  readManifest,
  restoreSeed,
  seedProblems,
} from "./seed";

const WINDOWS = process.platform === "win32";
const MAC = process.platform === "darwin";
const HOME = homedir();
const BUILDS = resolve(process.argv[2] ?? "builds");
const ONLY = process.argv.slice(3);
const DIR = join(HOME, "eta-e2e");
const EXE = join(DIR, WINDOWS ? "eta-host.exe" : "eta-host");
const DATA = join(HOME, ".eta");
const SERVICE = "io.eta.host";
const PORT = 18_790;
const UP = `http://127.0.0.1:${PORT}/up`;
const RELEASES_PORT = 19_900;
const RELEASES = `http://127.0.0.1:${RELEASES_PORT}/repos/o/r`;
const ASSET = WINDOWS
  ? `eta-host-windows-${process.arch}.exe`
  : `eta-host-${process.platform}-${process.arch}`;
const CONFIG = join(DATA, "service", `${SERVICE}.json`);
const UID = process.getuid?.() ?? 501;
const LAUNCHD = `gui/${UID}/${SERVICE}`;
const PLIST = join(HOME, "Library", "LaunchAgents", `${SERVICE}.plist`);
const SHOTS = resolve("e2e-shots");
const FROM = process.env.ETA_E2E_FROM;
const TO = process.env.ETA_E2E_TO;
const REAL = process.env.ETA_E2E_REAL === "1";
const BAD = "99.0.0";
/**
 * Where the build that does not hold waits outside its own scenario. Listed, it would be the
 * highest release there is, and that is what every upgrade without a version takes: the latest
 * full release, or with pre-releases on the highest of all.
 */
const BAD_AWAY = join(BUILDS, `.${BAD}`);

let failures = 0;
let checks = 0;
const results: {
  scenario: string;
  check: string;
  ok: boolean;
  detail: string;
}[] = [];
let scenario = "";

function record(check: string, ok: boolean, detail: string): void {
  checks += 1;
  if (!ok) failures += 1;
  results.push({ scenario, check, ok, detail });
  console.log(`  ${ok ? "ok  " : "FAIL"} ${check}${ok ? "" : `: ${detail}`}`);
}
const want = (check: string, actual: unknown, expected: unknown): void =>
  record(
    check,
    JSON.stringify(actual) === JSON.stringify(expected),
    `wanted ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
const has = (check: string, text: string, part: string): void =>
  record(check, text.includes(part), `no [${part}] in: ${text}`);

interface Ran {
  code: number;
  out: string;
}

/** A command to its end, stdin given if there is any, with what it printed on either stream. */
function run(
  file: string,
  args: readonly string[],
  options: { env?: Record<string, string>; input?: string } = {},
): Promise<Ran> {
  return new Promise((done, reject) => {
    const child = spawn(file, [...args], {
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => done({ code: code ?? 1, out: out.trim() }));
    child.stdin.end(options.input ?? "");
  });
}

const eta = (args: string[], env: Record<string, string> = {}): Promise<Ran> =>
  run(EXE, args, {
    env: { ...(REAL ? {} : { ETA_RELEASES_URL: RELEASES }), ...env },
  });

const fileVersion = async (path: string = EXE): Promise<string> =>
  (await run(path, ["--version"])).out.split(" ")[1] ?? "";

async function up(): Promise<boolean> {
  try {
    const answer = await fetch(UP, { signal: AbortSignal.timeout(3000) });
    return answer.ok;
  } catch {
    return false;
  }
}

async function waitFor(
  what: string,
  check: () => boolean | Promise<boolean>,
  seconds = 60,
): Promise<boolean> {
  for (const until = Date.now() + seconds * 1000; Date.now() < until; ) {
    if (await check()) return true;
    await sleep(250);
  }
  console.log(`  ...gave up waiting for ${what}`);
  return false;
}

// The service, by the system's own tools.

async function hostPid(): Promise<number> {
  if (WINDOWS) {
    const state = JSON.parse(
      readFileSync(join(DATA, "service", `${SERVICE}.state.json`), "utf8"),
    ) as { pid: number; state: string };
    return state.state === "running" ? state.pid : 0;
  }
  if (MAC) {
    const { out } = await run("launchctl", ["print", LAUNCHD]);
    return Number(/^\tpid = (\d+)$/m.exec(out)?.[1] ?? 0);
  }
  const { out } = await run("systemctl", [
    "--user",
    "show",
    SERVICE,
    "-p",
    "MainPID",
    "--value",
  ]);
  return Number(out);
}

/** sc.exe's 1060, service not found, as Bun's exit code: it keeps eight bits. */
const NO_SUCH_SERVICE = 1060 % 256;

async function serviceState(): Promise<
  "running" | "stopped" | "absent" | "changing"
> {
  if (WINDOWS) {
    const { code, out } = await run("sc.exe", ["query", SERVICE]);
    if (code === NO_SUCH_SERVICE) return "absent";
    if (/:\s*4\s/.test(out)) return "running";
    return /:\s*1\s/.test(out) ? "stopped" : "changing";
  }
  if (MAC) {
    if (!existsSync(PLIST)) return "absent";
    const { code, out } = await run("launchctl", ["print", LAUNCHD]);
    return code === 0 && /^\tstate = running$/m.test(out)
      ? "running"
      : "stopped";
  }
  const { out } = await run("systemctl", ["--user", "is-active", SERVICE]);
  if (out === "active") return "running";
  return existsSync(
    join(HOME, ".config", "systemd", "user", `${SERVICE}.service`),
  )
    ? "stopped"
    : "absent";
}

async function stopService(): Promise<void> {
  if (WINDOWS) {
    await run("sc.exe", ["stop", SERVICE]);
    await waitFor(
      "the service to stop",
      async () => {
        const { out } = await run("sc.exe", ["query", SERVICE]);
        return /:\s*1\s/.test(out);
      },
      150,
    );
  } else if (MAC) {
    await run("launchctl", ["bootout", LAUNCHD]);
  } else {
    await run("systemctl", ["--user", "stop", SERVICE]);
  }
}

async function startService(): Promise<void> {
  if (WINDOWS) await run("sc.exe", ["start", SERVICE]);
  else if (MAC) {
    // It turns a label away for a moment after a bootout.
    await waitFor(
      "launchd to take it",
      async () =>
        (await run("launchctl", ["bootstrap", `gui/${UID}`, PLIST])).code === 0,
      15,
    );
  } else await run("systemctl", ["--user", "start", SERVICE]);
}

/** What the page's button sees has to come from the service's own environment. */
async function serviceKnowsReleases(): Promise<void> {
  if (WINDOWS) {
    const config = JSON.parse(readFileSync(CONFIG, "utf8")) as {
      env: Record<string, string>;
    };
    config.env.ETA_RELEASES_URL = RELEASES;
    await stopService();
    writeFileSync(CONFIG, JSON.stringify(config));
    await startService();
  } else if (MAC) {
    await stopService();
    const plist = readFileSync(PLIST, "utf8").replace(
      "<key>EnvironmentVariables</key><dict>",
      `<key>EnvironmentVariables</key><dict><key>ETA_RELEASES_URL</key><string>${RELEASES}</string>`,
    );
    writeFileSync(PLIST, plist);
    await startService();
  } else {
    const unit = join(HOME, ".config", "systemd", "user", `${SERVICE}.service`);
    const text = readFileSync(unit, "utf8").replace(
      "[Service]\n",
      `[Service]\nEnvironment="ETA_RELEASES_URL=${RELEASES}"\n`,
    );
    writeFileSync(unit, text);
    await run("systemctl", ["--user", "daemon-reload"]);
    await run("systemctl", ["--user", "restart", SERVICE]);
  }
  await waitFor("/up", up);
}

/** Its processes that are not the service's main one, by where their files are. */
async function leftovers(): Promise<string[]> {
  const unpacked = WINDOWS ? ".eta\\unpacked" : ".eta/unpacked";
  if (WINDOWS) {
    const { out } = await run("powershell.exe", [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process | Select-Object -ExpandProperty ExecutablePath -ErrorAction SilentlyContinue",
    ]);
    return out.split(/\r?\n/).filter((path) => path.includes(unpacked));
  }
  const { out } = await run("ps", ["-axwwo", "command"]);
  return out.split("\n").filter((line) => line.includes(unpacked));
}

async function installOver(
  version: string,
  flags: string[] = [],
): Promise<Ran> {
  mkdirSync(DIR, { recursive: true });
  copyFileSync(join(BUILDS, version, ASSET), EXE);
  chmodSync(EXE, 0o755);
  return run(
    EXE,
    ["install-service", "--port", String(PORT), "--no-web", ...flags],
    { input: `${process.env.ETA_E2E_PASSWORD ?? ""}\n` },
  );
}

/** Delete what a program ran from: Windows holds such a file for a while after it has exited. */
async function removeHeld(path: string): Promise<void> {
  let held: unknown;
  const removed = await waitFor(
    `${path} to be let go`,
    () => {
      try {
        rmSync(path, { recursive: true, force: true });
        return true;
      } catch (error) {
        held = error;
        return false;
      }
    },
    60,
  );
  if (!removed) throw held;
}

async function uninstall(): Promise<Ran | undefined> {
  if (!existsSync(EXE)) return undefined;
  return run(EXE, ["uninstall-service"]);
}

function sql(query: string): unknown[] {
  const db = new Database(join(DATA, "eta.sqlite"));
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    return db.query(query).all();
  } finally {
    db.close();
  }
}
const write = (query: string): void => {
  sql(query);
};

/** What runs from a file under `dir`, by the system's own process list. */
async function runningFrom(dir: string): Promise<string[]> {
  if (WINDOWS) {
    const { out } = await run("powershell.exe", [
      "-NoProfile",
      "-Command",
      'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ExecutablePath)" }',
    ]);
    const under = `${dir.toLowerCase()}\\`;
    return out
      .split(/\r?\n/)
      .filter((line) => line.toLowerCase().includes(under));
  }
  const { out } = await run("ps", ["-axwwo", "pid=,command="]);
  return out.split("\n").filter((line) => line.includes(`${dir}/`));
}

/**
 * Nothing installed. An uninstall has to stop everything that ran from these: when the folder
 * cannot be deleted at once, nothing may be running from it. On Windows the file of a program that
 * has just exited (here the `uninstall-service` that just ran from it, or a service process that
 * has just ended) can still be held for a moment with nothing running, and a delete in that moment
 * fails with EBUSY: that is waited out, and said (#257).
 */
async function clean(): Promise<void> {
  await uninstall();
  try {
    rmSync(DIR, { recursive: true, force: true });
  } catch (error) {
    const held = Date.now();
    const running = await runningFrom(DIR);
    if (running.length > 0) {
      want("the uninstall left nothing running from its folder", running, []);
      throw error;
    }
    await removeHeld(DIR);
    console.log(
      `    | ${DIR} was held with nothing running from it (${String(error)}); let go after ${Date.now() - held} ms`,
    );
  }
  rmSync(DATA, { recursive: true, force: true });
}

/** A clean service on 0.9.0 with a task on its board. */
async function reset(flags: string[] = ["--no-llm"]): Promise<void> {
  await clean();
  const installed = await installOver("0.9.0", flags);
  if (installed.code !== 0) throw new Error(`install: ${installed.out}`);
  if (!(await waitFor("0.9.0 to answer", up, 120)))
    throw new Error("0.9.0 did not come up");
  write(
    "INSERT INTO task (id, title, created_at, updated_at) VALUES ('seed', 'survives', 1, 1)",
  );
}

async function expectOld(): Promise<void> {
  want("the file is the old build", await fileVersion(), "0.9.0");
  want("the service runs", await serviceState(), "running");
  want("/up", await up(), true);
  want("the data is there", sql("SELECT title FROM task WHERE id = 'seed'"), [
    { title: "survives" },
  ]);
  want(
    "the old schema is back",
    sql(
      "SELECT count(*) AS n FROM pragma_table_info('project') WHERE name = 'archived'",
    ),
    [{ n: 1 }],
  );
  want(
    "no trace of the new migration",
    sql("SELECT count(*) AS n FROM eta_migrations WHERE id LIKE '9001%'"),
    [{ n: 0 }],
  );
}

async function expectNew(before: number): Promise<void> {
  want("the file is the new build", await fileVersion(), "0.9.1");
  want("the service runs", await serviceState(), "running");
  want("/up", await up(), true);
  record(
    "it is a new process",
    (await hostPid()) !== before,
    `pid ${before} still`,
  );
  want("the data is there", sql("SELECT title FROM task WHERE id = 'seed'"), [
    { title: "survives" },
  ]);
  want("the migration ran", sql("SELECT note FROM e2e_mark"), [
    { note: "0.9.1 was here" },
  ]);
  want("the old build is kept", await fileVersion(`${EXE}.prev`), "0.9.0");
  record(
    "a backup was taken",
    readdirSync(join(DATA, "backups")).some((file) =>
      file.endsWith("-0.9.0.sqlite"),
    ),
    "no backup",
  );
}

interface Status {
  state: string;
  phase: string;
  error?: string;
  log: string[];
}

function upgradeStatus(): Status | undefined {
  try {
    return JSON.parse(
      readFileSync(join(DATA, "upgrade-status.json"), "utf8"),
    ) as Status;
  } catch {
    return undefined;
  }
}

/** How it ended, with what it said about it when that is not good. */
function ended(): string | undefined {
  const status = upgradeStatus();
  if (status?.error !== undefined) console.log(`    | ${status.error}`);
  return status?.state;
}

const finished = (): Promise<boolean> =>
  waitFor(
    "the upgrade to end",
    () => {
      const status = upgradeStatus();
      return status !== undefined && status.state !== "running";
    },
    240,
  );

/**
 * The page's button: the same call, from the same place, on the service's own rights. With
 * `prerelease`, the switch under Settings → Update is turned on first, as a person going to a
 * pre-release has to: the latest release is never one, so the button would not offer it. With
 * `offers`, the page has to show that version before the button is pressed: pressed on anything
 * else, it would upgrade to the wrong build and only the end state would say so.
 */
async function pressButton({
  force = false,
  prerelease = false,
  offers,
}: {
  force?: boolean;
  prerelease?: boolean;
  offers?: string;
} = {}): Promise<{
  switched: boolean;
}> {
  const client = await connect(`ws://127.0.0.1:${PORT}/ws`, {
    origin: `http://127.0.0.1:${PORT}`,
  });
  await client.hello();
  let check = (await client.call("upgrade", "check")) as Check;
  // A build from before the switch has none, and takes the latest release as it comes.
  const switched = prerelease && hasPrereleaseSwitch(check);
  if (switched) {
    want(
      "pre-releases are on",
      await client.call("upgrade", "setPrerelease", { prerelease: true }),
      { prerelease: true },
    );
    check = (await client.call("upgrade", "check")) as Check;
  }
  want("the page may update", check.blocked, null);
  if (offers !== undefined) {
    want("the page offers it", check.latest, offers);
    if (check.latest !== offers) {
      client.close();
      throw new Error(`the button was not pressed: it offers ${check.latest}`);
    }
  }
  await client.call("upgrade", "start", { force });
  client.close();
  return { switched };
}

/**
 * The switch `pressButton` turned on, as the build upgraded to sees it, then off again: the seed
 * check compares every setting, and this one is the test's, not the seed's.
 */
async function prereleaseKeptThenOff(): Promise<void> {
  const client = await connect(`ws://127.0.0.1:${PORT}/ws`, {
    origin: `http://127.0.0.1:${PORT}`,
  });
  await client.hello();
  const check = (await client.call("upgrade", "check")) as Check;
  want("pre-releases are still on", check.prerelease, true);
  await client.call("upgrade", "setPrerelease", { prerelease: false });
  client.close();
}

const pinLatest = (version: string): void =>
  writeFileSync(join(BUILDS, "latest"), version);

/** A service on FROM, holding the seed. */
async function seeded(from: string): Promise<ReturnType<typeof readManifest>> {
  await clean();
  const installed = await installOver(from, ["--no-llm"]);
  if (installed.code !== 0) throw new Error(`install: ${installed.out}`);
  if (!(await waitFor(`${from} to answer`, up, 120)))
    throw new Error(`${from} did not come up`);
  await stopService();
  const seed = chooseSeed(from);
  restoreSeed(seed, DATA, HOME);
  await startService();
  if (!(await waitFor(`${from} to answer on the seed`, up, 120)))
    throw new Error(`${from} did not come up on the seed`);
  const manifest = readManifest(seed);
  want("the seed went in", seedProblems(manifest, DATA), []);
  return manifest;
}

/** What each of these upgrades has to leave, with `after` the build the service ends up on. */
async function seedHolds(
  manifest: ReturnType<typeof readManifest>,
  after: string,
): Promise<void> {
  want("the file", await fileVersion(), after);
  want("the service runs", await serviceState(), "running");
  want("/up", await up(), true);
  want("the seed is all there", seedProblems(manifest, DATA), []);
  const carried = (await run(EXE, ["--migrations"])).out.split("\n");
  const applied = sql("SELECT id FROM eta_migrations ORDER BY id") as {
    id: string;
  }[];
  want(
    "every migration of the build is recorded",
    carried.filter((id) => !applied.some((row) => row.id === id)),
    [],
  );
  const page = await fetch(`http://127.0.0.1:${PORT}/`);
  has("the page opens", await page.text(), "<html");

  const client = await connect(`ws://127.0.0.1:${PORT}/ws`, {
    origin: `http://127.0.0.1:${PORT}`,
  });
  await client.hello();
  const { id, replied, said } = manifest.conversation;
  const lines = async (): Promise<string[]> => {
    const { messages } = (await client.call("conversations", "history", {
      conversationId: id,
    })) as { messages: { text: string }[] };
    return messages.map(({ text }) => text);
  };
  const old = await lines();
  record(
    "the conversation opens with what was said",
    old.some((text) => text.includes(said)),
    old.join(" | "),
  );
  record("and what was answered", old.includes(replied), old.join(" | "));
  const agent = (
    sql("SELECT id FROM agent WHERE name = 'Ada'") as { id: string }[]
  )[0]!.id;
  const next = `Still there after ${after}?`;
  await client.call("conversations", "send", {
    conversationId: id,
    text: `@Ada ${next}`,
    mentions: [agent],
  });
  await until(
    async () =>
      (await lines()).some(
        (text) => text.startsWith("Heard") && text.includes(next),
      ),
    30_000,
  ).then(
    () => record("the conversation goes on", true, ""),
    (error: unknown) =>
      record("the conversation goes on", false, String(error)),
  );
  // The seed's group has Ada as its steward (its project's, before 0.5): a message that names
  // nobody still goes to her after the upgrade, and nobody else joins for it.
  const unnamed = `Anyone there after ${after}?`;
  const sent = (await client.call("conversations", "send", {
    conversationId: id,
    text: unnamed,
  })) as { replies: { agentId: string | null }[] };
  want(
    "a message that names nobody goes to the steward",
    sent.replies.map((reply) => reply.agentId),
    [agent],
  );
  await until(
    async () =>
      (await lines()).some(
        (text) => text.startsWith("Heard") && text.includes(unnamed),
      ),
    30_000,
  ).then(
    () => record("and the steward answers it", true, ""),
    (error: unknown) =>
      record("and the steward answers it", false, String(error)),
  );
  client.close();
}

const CROSS: Record<string, () => Promise<void>> = {
  "from a release to the next, by the command": async () => {
    const manifest = await seeded(FROM!);
    const before = await hostPid();
    const { code, out } = await eta(["upgrade", TO!]);
    console.log(out.replace(/^/gm, "    | "));
    want("exit", code, 0);
    record("it is a new process", (await hostPid()) !== before, "same pid");
    want("the old build is kept", await fileVersion(`${EXE}.prev`), FROM);
    record(
      "a backup was taken",
      readdirSync(join(DATA, "backups")).some((file) =>
        file.endsWith(`-${FROM}.sqlite`),
      ),
      "no backup",
    );
    await seedHolds(manifest, TO!);
  },

  "from a release to the next, by the button": async () => {
    const manifest = await seeded(FROM!);
    if (!REAL) {
      await serviceKnowsReleases();
      pinLatest(TO!);
    }
    const { switched } = await pressButton({
      prerelease: TO!.includes("-"),
      offers: TO!,
    });
    await finished();
    want("it ended", ended(), "done");
    await waitFor("/up", up);
    if (switched) await prereleaseKeptThenOff();
    await seedHolds(manifest, TO!);
  },

  "a build that does not hold goes back, with the seed": async () => {
    if (REAL) return;
    const manifest = await seeded(FROM!);
    renameSync(BAD_AWAY, join(BUILDS, BAD));
    const { code, out } = await eta(["upgrade", BAD]).finally(() =>
      renameSync(join(BUILDS, BAD), BAD_AWAY),
    );
    console.log(out.replace(/^/gm, "    | "));
    want("exit", code, 1);
    has("it says so", out, "did not hold");
    has("and where it is", out, `back on ${FROM}`);
    await waitFor("/up", up);
    await seedHolds(manifest, FROM!);
    want(
      "no trace of its migration",
      sql("SELECT count(*) AS n FROM eta_migrations WHERE id LIKE '9999%'"),
      [{ n: 0 }],
    );
  },
};

const SCENARIOS: Record<string, () => Promise<void>> = {
  "a service installs and answers": async () => {
    await reset();
    want("the service runs", await serviceState(), "running");
    want("/up", await up(), true);
    record(
      "its data is in the user's home",
      existsSync(join(DATA, "eta.sqlite")),
      "no ~/.eta/eta.sqlite",
    );
    if (WINDOWS) {
      const { out } = await run("sc.exe", ["qc", SERVICE]);
      has(
        "it runs as this user",
        out.toLowerCase(),
        process.env.USERNAME?.toLowerCase() ?? "?",
      );
      record("not as SYSTEM", !/LocalSystem/i.test(out), out);
      has("it starts at boot", out, "AUTO_START");
      const { env } = JSON.parse(readFileSync(CONFIG, "utf8")) as {
        env: { PATH?: string };
      };
      record(
        "it got this user's PATH, split on Windows's separator",
        (env.PATH ?? "").includes(";") && /[\\/]system32/i.test(env.PATH ?? ""),
        JSON.stringify(env),
      );
      const repeat = await run(EXE, [
        "install-service",
        "--port",
        String(PORT),
        "--no-web",
        "--no-llm",
      ]);
      want("installing again asks for nothing", repeat.code, 0);
      await waitFor("/up", up);
      want("and it is up again", await up(), true);
    }
  },

  "what a service costs, and whose it is": async () => {
    if (!WINDOWS) return;
    await reset();
    const { out } = await run("powershell.exe", [
      "-NoProfile",
      "-Command",
      `Get-CimInstance Win32_Process -Filter "Name='eta-host.exe'" | ForEach-Object { "$($_.WorkingSetSize / 1MB -as [int]) MB: $($_.CommandLine)" }`,
    ]);
    console.log(out.replace(/^/gm, "    | "));
    record(
      "the shell and the host are two processes of one file",
      out.includes("service-run") && out.split("\n").length >= 2,
      out,
    );
  },

  "a wrong password installs nothing": async () => {
    if (!WINDOWS) return;
    await uninstall();
    mkdirSync(DIR, { recursive: true });
    copyFileSync(join(BUILDS, "0.9.0", ASSET), EXE);
    const wrong = await run(
      EXE,
      ["install-service", "--port", String(PORT), "--no-web", "--no-llm"],
      { input: "certainly-not-it\n" },
    );
    want("exit", wrong.code, 1);
    has("it says so", wrong.out, "not the password");
    want("no service", await serviceState(), "absent");
  },

  "another account is told what to do": async () => {
    if (!WINDOWS) return;
    await reset();
    const dir = "C:\\eta-e2e-other";
    mkdirSync(dir, { recursive: true });
    const copy = join(dir, "eta-host.exe");
    copyFileSync(EXE, copy);
    const password = "Eta-other-1a!";
    const script = `
      net user etaother '${password}' /add | Out-Null
      icacls ${dir} /grant 'etaother:(OI)(CI)F' | Out-Null
      $credential = New-Object PSCredential('etaother', (ConvertTo-SecureString '${password}' -AsPlainText -Force))
      foreach ($command in @('install-service --port 1', 'uninstall-service', 'upgrade --cancel')) {
        $out = '${dir}\\out.txt'
        $process = Start-Process -FilePath '${copy}' -ArgumentList $command -Credential $credential -WorkingDirectory '${dir}' -RedirectStandardError $out -NoNewWindow -Wait -PassThru
        "$command => exit $($process.ExitCode): $(Get-Content $out -Raw)"
      }
      net user etaother /delete | Out-Null
    `;
    const { out } = await run("powershell.exe", [
      "-NoProfile",
      "-Command",
      script,
    ]);
    console.log(out.replace(/^/gm, "    | "));
    has(
      "install says Administrator",
      out,
      "install-service --port 1 => exit 1: eta-host install-service: install-service takes an Administrator terminal",
    );
    has(
      "uninstall says Administrator",
      out,
      "uninstall-service takes an Administrator terminal",
    );
    want("it left the service alone", await serviceState(), "running");
    const { out: paths } = await run("powershell.exe", [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process | Select-Object -ExpandProperty ExecutablePath -ErrorAction SilentlyContinue",
    ]);
    want(
      "nothing it started is still running",
      paths.split(/\r?\n/).filter((path) => path.startsWith(dir)),
      [],
    );
    await removeHeld(dir);
  },

  "the command upgrades the service": async () => {
    await reset();
    const before = await hostPid();
    const { code, out } = await eta(["upgrade", "0.9.1"]);
    console.log(out.replace(/^/gm, "    | "));
    want("exit", code, 0);
    await expectNew(before);
  },

  "a service installed by an older build": async () => {
    if (!MAC) return;
    await reset();
    // What every build before this one wrote: none of the keys that came with this.
    await stopService();
    writeFileSync(
      PLIST,
      readFileSync(PLIST, "utf8").replace(
        /<key>ExitTimeOut<\/key>[\s\S]*?(<\/dict><\/plist>)/,
        "$1",
      ),
    );
    await startService();
    await waitFor("/up", up);
    const before = await hostPid();
    const { code } = await eta(["upgrade", "0.9.1"]);
    want("exit", code, 0);
    await expectNew(before);
  },

  "the page's button upgrades the service": async () => {
    await reset();
    await serviceKnowsReleases();
    pinLatest("0.9.1");
    const before = await hostPid();
    await pressButton();
    await finished();
    want("it ended", ended(), "done");
    await waitFor("/up", up);
    await expectNew(before);
  },

  "a person presses the button on the page": async () => {
    // Not a dependency of the repository: the workflow installs it for this.
    const name = "playwright-core";
    const { chromium } = (await import(
      name
    )) as typeof import("playwright-core");
    await reset();
    await serviceKnowsReleases();
    pinLatest("0.9.1");
    mkdirSync(SHOTS, { recursive: true });
    const browser = await chromium.launch({ channel: "chrome" });
    const context = await browser.newContext({
      viewport: { width: 1180, height: 760 },
      // The labels below are the page's English ones.
      locale: "en-US",
      colorScheme: "light",
    });
    const page = await context.newPage();
    const shot = (file: string) =>
      page.screenshot({ path: join(SHOTS, `${process.platform}-${file}.png`) });
    const hostVersion = page.getByTestId("host-version");
    /**
     * The row once the Host has answered: since #1037 it is drawn from the first
     * paint and says "—" until its first check comes back, so the row being on
     * the page is not the answer, a version in it is.
     */
    const answered = hostVersion.filter({ hasText: /\d+\.\d+\.\d+/ });
    const settings = async (): Promise<void> => {
      // On a desktop-wide window Settings is a page of its own, not a dialog.
      await page.goto(`http://127.0.0.1:${PORT}/?settings=update`);
      await answered.waitFor({ timeout: 60_000 });
    };
    const shown = async (): Promise<string> => {
      const version = (await answered.textContent({ timeout: 30_000 })) ?? "";
      return version.replace("Current version", "").trim();
    };

    await settings();
    want("the page says the old build", await shown(), "0.9.0");
    await shot("1-update-available");
    await page.getByRole("button", { name: /^Update to / }).click();
    await page.getByRole("dialog", { name: /^Update the Host to / }).waitFor();
    await shot("2-confirm");
    await page
      .getByRole("dialog", { name: /^Update the Host to / })
      .getByRole("button", { name: "Update", exact: true })
      .click();
    const screen = page.getByRole("alert", {
      name: "Host update in progress",
    });
    await screen.waitFor({ timeout: 60_000 });
    await shot("3-restarting");
    await waitFor(
      "the upgrade to end",
      () => upgradeStatus()?.state === "done",
      120,
    );
    await waitFor("/up", up);
    await sleep(3000);
    await settings();
    want("the page says the new build", await shown(), "0.9.1");
    await shot("4-updated");

    pinLatest("0.9.3");
    await settings();
    await page.getByRole("button", { name: /^Update to / }).click();
    await page.getByRole("dialog", { name: /^Update the Host to / }).waitFor();
    await page
      .getByRole("dialog", { name: /^Update the Host to / })
      .getByRole("button", { name: "Update", exact: true })
      .click();
    try {
      await page
        // The window says so over everything, then Settings keeps it (#292).
        .getByText("The update to 0.9.3 didn't hold", { exact: true })
        .waitFor({ timeout: 180_000 });
      await shot("5-rolled-back");
      want("it went back", await fileVersion(), "0.9.1");
    } catch (error) {
      await shot("5-what-the-page-shows");
      console.log(`    | ${JSON.stringify(upgradeStatus())}`);
      throw error;
    } finally {
      await browser.close();
    }
  },

  "a build that does not start goes back": async () => {
    await reset();
    write(
      "INSERT INTO task (id, title, created_at, updated_at) VALUES ('late', 'written just before', 1, 1)",
    );
    const { code, out } = await eta(["upgrade", "0.9.2"]);
    console.log(out.replace(/^/gm, "    | "));
    want("exit", code, 1);
    has("it says so", out, "did not hold");
    has("and where it is", out, "back on 0.9.0");
    await expectOld();
    want(
      "the last write survived",
      sql("SELECT title FROM task WHERE id = 'late'"),
      [{ title: "written just before" }],
    );
  },

  "a build that dies after coming up goes back, from the button": async () => {
    await reset();
    await serviceKnowsReleases();
    pinLatest("0.9.3");
    await pressButton();
    await finished();
    want("it ended", ended(), "rolled-back");
    await waitFor("/up", up);
    await expectOld();
  },

  "a wrong checksum changes nothing": async () => {
    await reset();
    const dir = join(BUILDS, "0.9.5");
    mkdirSync(dir, { recursive: true });
    copyFileSync(join(BUILDS, "0.9.1", ASSET), join(dir, ASSET));
    writeFileSync(join(dir, "SHA256SUMS"), `${"0".repeat(64)}  ${ASSET}\n`);
    const before = await hostPid();
    const { code, out } = await eta(["upgrade", "0.9.5"]);
    rmSync(dir, { recursive: true, force: true });
    want("exit", code, 1);
    has("it says so", out, "checksum");
    want("the same process", await hostPid(), before);
    await expectOld();
    want(
      "nothing left",
      readdirSync(DIR).filter((f) => f.includes(".next")),
      [],
    );
  },

  "agents hold it, --wait gives up, --cancel stops it, --force goes":
    async () => {
      await reset();
      write(
        "INSERT INTO task_run (id, task_id, status, created_at) VALUES ('r', 'seed', 'running', 1)",
      );
      const before = await hostPid();
      const refused = await eta(["upgrade", "0.9.1", "--wait", "0"]);
      want("exit", refused.code, 1);
      // On Windows the staged build's trial run had only just exited when the refusal came, and
      // deleting the file then failed with EBUSY, which was all the command said (#257).
      has("it names what is working", refused.out, "survives");
      want(
        "it took the staged build away",
        readdirSync(DIR).filter((f) => f.includes(".next")),
        [],
      );
      want("the same process", await hostPid(), before);

      const waiting = eta(["upgrade", "0.9.1"]);
      await waitFor("it to wait", () => upgradeStatus()?.phase === "waiting");
      const cancelled = await eta(["upgrade", "--cancel"]);
      want("--cancel", cancelled.code, 0);
      await finished();
      want("it was cancelled", upgradeStatus()?.state, "cancelled");
      await waiting;
      want("the same process", await hostPid(), before);
      want("the file is the old build", await fileVersion(), "0.9.0");
      want("no lock left", existsSync(join(DATA, "upgrade.lock")), false);

      const forced = await eta(["upgrade", "0.9.1", "--force"]);
      want("--force exit", forced.code, 0);
      want("the file is the new build", await fileVersion(), "0.9.1");
    },

  "killing the command does not stop the upgrade": async () => {
    await reset();
    const log = join(HOME, "e2e-follow.log");
    rmSync(log, { force: true });
    const child = spawn(EXE, ["upgrade", "0.9.1"], {
      env: { ...process.env, ETA_RELEASES_URL: RELEASES },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk: Buffer) => appendFileSync(log, chunk));
    await waitFor("the restart", () =>
      ["stopping", "backing-up", "restarting", "verifying"].includes(
        upgradeStatus()?.phase ?? "",
      ),
    );
    child.kill("SIGKILL");
    want(
      "it was killed with the upgrade under way",
      upgradeStatus()?.state,
      "running",
    );
    await finished();
    want("it ended", ended(), "done");
    want("the file is the new build", await fileVersion(), "0.9.1");
    want("the service runs", await serviceState(), "running");
    await waitFor("/up", up);
    want("/up", await up(), true);
  },

  "a stop is a clean exit and takes everything with it": async () => {
    await reset([]);
    // It starts after the host answers `/up`.
    await waitFor(
      "CLIProxyAPI",
      async () => (await leftovers()).length > 0,
      30,
    );
    record(
      "CLIProxyAPI is running under it",
      (await leftovers()).length > 0,
      "nothing to look for",
    );
    await stopService();
    want("the service stopped", await serviceState(), "stopped");
    await waitFor(
      "its children to go",
      async () => (await leftovers()).length === 0,
      20,
    );
    want("nothing is left", await leftovers(), []);
    if (WINDOWS) {
      const state = JSON.parse(
        readFileSync(join(DATA, "service", `${SERVICE}.state.json`), "utf8"),
      ) as { state: string; exitCode: number };
      want("the shell saw it stop", state.state, "stopped");
      want("and the host exit by itself", state.exitCode, 0);
      const log = readFileSync(join(DATA, "service", `${SERVICE}.log`), "utf8");
      record(
        "it did not have to kill it",
        !log.includes("did not stop"),
        log.slice(-400),
      );
    }
  },

  "a host that ignores the stop is killed, children and all": async () => {
    if (!WINDOWS) return;
    await clean();
    mkdirSync(DIR, { recursive: true });
    copyFileSync(join(BUILDS, "0.9.4", ASSET), EXE);
    const installed = await run(
      EXE,
      ["install-service", "--port", String(PORT), "--no-web"],
      {
        input: `${process.env.ETA_E2E_PASSWORD ?? ""}\n`,
      },
    );
    want("install", installed.code, 0);
    await waitFor("/up", up, 120);
    const config = JSON.parse(readFileSync(CONFIG, "utf8")) as object;
    await stopService();
    want("it was killed after its time", await serviceState(), "stopped");
    writeFileSync(CONFIG, JSON.stringify({ ...config, stopSeconds: 5 }));
    await startService();
    await waitFor("/up", up, 120);
    await waitFor(
      "CLIProxyAPI",
      async () => (await leftovers()).length > 0,
      30,
    );
    const started = Date.now();
    await stopService();
    want("it stopped", await serviceState(), "stopped");
    const seconds = (Date.now() - started) / 1000;
    record(
      "after the time it was given",
      seconds >= 4 && seconds < 30,
      `${seconds}s`,
    );
    await waitFor(
      "its children to go",
      async () => (await leftovers()).length === 0,
      20,
    );
    want("nothing is left", await leftovers(), []);
  },

  "a crash is restarted": async () => {
    await reset();
    const before = await hostPid();
    process.kill(before, "SIGKILL");
    await sleep(1000);
    const again = await waitFor(
      "a new process",
      async () => {
        const now = await hostPid();
        return now !== 0 && now !== before && (await up());
      },
      60,
    );
    want("it came back", again, true);
  },

  "an upgrade between two starts of a crash": async () => {
    await reset();
    process.kill(await hostPid(), "SIGKILL");
    await sleep(1000);
    const { code, out } = await eta(["upgrade", "0.9.1"]);
    console.log(out.replace(/^/gm, "    | "));
    want("exit", code, 0);
    has("it was stopped, not left to the manager", out, "Stopping the service");
    want("the file is the new build", await fileVersion(), "0.9.1");
    await waitFor("/up", up);
    want("/up", await up(), true);
  },

  "with the service stopped only the file changes": async () => {
    await reset();
    await stopService();
    const { code, out } = await eta(["upgrade", "0.9.1"]);
    console.log(out.replace(/^/gm, "    | "));
    want("exit", code, 0);
    has("it says how to start it", out, "The service is stopped");
    want("it stayed stopped", await serviceState(), "stopped");
    want("the file is the new build", await fileVersion(), "0.9.1");
    await startService();
    await waitFor("/up", up, 120);
    want("it starts on the new build", await up(), true);
  },

  "a service on another file is refused": async () => {
    await reset();
    const other = join(HOME, "e2e-other");
    mkdirSync(other, { recursive: true });
    const copy = join(other, WINDOWS ? "eta-host.exe" : "eta-host");
    copyFileSync(EXE, copy);
    chmodSync(copy, 0o755);
    const { code, out } = await run(copy, ["upgrade", "0.9.1"], {
      env: { ETA_RELEASES_URL: RELEASES },
    });
    await removeHeld(other);
    want("exit", code, 1);
    has("it says so", out, "the service runs");
    want("the file is the old build", await fileVersion(), "0.9.0");
  },

  "uninstalling leaves nothing": async () => {
    await reset();
    await eta(["upgrade", "0.9.1"]);
    const removed = await uninstall();
    want("exit", removed?.code, 0);
    want("no service", await serviceState(), "absent");
    if (WINDOWS) {
      const worker = await run("sc.exe", ["query", `${SERVICE}-upgrade`]);
      want("no worker service", worker.code, NO_SUCH_SERVICE);
      want("no service files", existsSync(join(DATA, "service")), false);
      const { out } = await run("powershell.exe", [
        "-NoProfile",
        "-Command",
        "secedit /export /cfg $env:TEMP\\sec.cfg /areas USER_RIGHTS | Out-Null; Select-String SeServiceLogonRight $env:TEMP\\sec.cfg",
      ]);
      const sid = (
        await run("powershell.exe", [
          "-NoProfile",
          "-Command",
          "([System.Security.Principal.WindowsIdentity]::GetCurrent()).User.Value",
        ])
      ).out;
      record("the logon right went back", !out.includes(sid), out);
    } else if (MAC) {
      const job = await run("launchctl", ["print", LAUNCHD]);
      record("launchd has no job", job.code !== 0, job.out);
      const worker = await run("launchctl", [
        "print",
        `gui/${UID}/${SERVICE}-upgrade`,
      ]);
      record("nor a worker", worker.code !== 0, worker.out);
      want("no plist", existsSync(PLIST), false);
    }
    want("nothing runs", await hostAlive(), false);
    // What was installed works again, the password and the logon right with it.
    const again = await installOver("0.9.1", ["--no-llm"]);
    want("it installs again", again.code, 0);
    await waitFor("/up", up, 120);
    want("/up", await up(), true);
    await uninstall();
  },
};

async function hostAlive(): Promise<boolean> {
  return up();
}

const server = spawn(
  process.execPath,
  [join(import.meta.dir, "fake-releases.ts"), BUILDS, String(RELEASES_PORT)],
  { stdio: "ignore" },
);
const model = spawn(
  process.execPath,
  [join(import.meta.dir, "fake-model.ts"), String(MODEL_PORT)],
  { stdio: "ignore" },
);
await sleep(1000);
if (existsSync(join(BUILDS, BAD))) renameSync(join(BUILDS, BAD), BAD_AWAY);

try {
  const chosen = FROM !== undefined && TO !== undefined ? CROSS : SCENARIOS;
  for (const [name, body] of Object.entries(chosen)) {
    if (ONLY.length > 0 && !ONLY.some((part) => name.includes(part))) continue;
    scenario = name;
    rmSync(join(BUILDS, "latest"), { force: true });
    console.log(`== ${name}`);
    const started = Date.now();
    try {
      await body();
    } catch (error) {
      record("the scenario finished", false, String(error));
    }
    console.log(`   ${Math.round((Date.now() - started) / 1000)}s`);
  }
} finally {
  server.kill();
  model.kill();
  rmSync(join(BUILDS, "latest"), { force: true });
  if (existsSync(BAD_AWAY)) renameSync(BAD_AWAY, join(BUILDS, BAD));
}

writeFileSync("upgrade-e2e-results.json", JSON.stringify(results, null, 2));
console.log(`\n${checks} checks, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
