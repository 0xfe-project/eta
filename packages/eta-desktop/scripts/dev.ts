/**
 * `dev:desk`, sequenced.
 *
 * The shell asks 5173 who is home exactly once, at launch (src/main/index.ts), and
 * falls back to the built copy under views/ when nothing answers. So the order is the
 * whole job here: vite first, the launcher second. A window that opens while the dev
 * server is still booting does not retry — it shows a stale page and hot reload is
 * gone without ever saying so, which is a confusing way to fail.
 *
 * The client build still runs, alongside vite: the shell loads its tray image from
 * `views://eta/tray-18@2x.png`, so views/ has to be there even when the page itself
 * comes from the dev server.
 *
 *   bun run dev                       # vite + shell, one terminal
 *   ETA_CLIENT_URL=http://localhost:5180 …   # or at a dev server you started yourself
 */
import { spawn, type Subprocess } from "bun";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The same marker src/main/index.ts checks: a foreign app on this port answers 200
 * too, and a wrong UI that looks exactly like eta is the worse of the two failures. */
const MARKER = "AKRDWGSCNFM-Regular.woff2";
const devUrl = process.env["ETA_CLIENT_URL"] ?? "http://localhost:5173";
const clientDir = fileURLToPath(new URL("../../eta-client", import.meta.url));
const desktopDir = fileURLToPath(new URL("..", import.meta.url));
/** Bun's child-process resolver does not consistently find `bun` by name on Windows. */
const bun = process.execPath;
const electrobun = ["x", "--bun", "electrobun"];
/** vite is usually listening in well under a second; the rest of this is a cold tsc. */
const readyTimeoutMs = 30_000;

const log = (message: string) => console.log(`[eta-desktop] ${message}`);

const isOurs = (): Promise<boolean> => fetch(devUrl, { signal: AbortSignal.timeout(1_000) })
	.then(async (response) => response.ok && (await response.text()).includes(MARKER))
	.catch(() => false);

/** A `dev:web` already serving eta in another terminal is reused, not replaced, and
 * left running on the way out — killing someone else's server would be rude. */
const reused = await isOurs();
let vite: Subprocess | undefined;

if (reused) {
	log(`reusing the dev server already on ${devUrl}`);
} else {
	// The port goes to the script rather than being hardcoded here, so `dev` stays the
	// one place that decides what vite runs.
	const port = new URL(devUrl).port !== "" ? new URL(devUrl).port : "5173";
	vite = spawn([bun, "run", "dev", `--port=${port}`], { cwd: clientDir, stdout: "inherit", stderr: "inherit" });
	log(`waiting for the dev server on ${devUrl}`);
}

const stopVite = () => { if (vite !== undefined && vite.exitCode === null) vite.kill("SIGTERM"); };
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => { stopVite(); process.exit(0); });
}

async function waitUntilReady(): Promise<boolean> {
	if (vite === undefined) return isOurs();
	const deadline = Date.now() + readyTimeoutMs;
	while (Date.now() <= deadline) {
		if (await isOurs()) return true;
		if (vite.exitCode !== null) return false; // strictPort, most likely: something foreign owns it
		await Bun.sleep(200);
	}
	return false;
}

const build = spawn([bun, "run", "client"], { cwd: desktopDir, stdout: "inherit", stderr: "inherit" });
const [ready, buildExit] = await Promise.all([waitUntilReady(), build.exited]);

if (buildExit !== 0) {
	stopVite();
	process.exit(buildExit ?? 1);
}

if (!ready) {
	// Not fatal: views:// is a working page, only a frozen one. Say so, then open it.
	log(vite?.exitCode === null
		? "dev server did not identify itself in time — opening on views:// (no hot reload)"
		: "dev server exited — opening on views:// (no hot reload)");
}

if (!existsSync(join(desktopDir, ".hutch", "devkit", ".complete"))) {
	log("preparing the Electrobun SDK");
	const prepare = spawn([bun, ...electrobun, "prepare"], { cwd: desktopDir, stdout: "inherit", stderr: "inherit" });
	const prepareExit = await prepare.exited;
	if (prepareExit !== 0) {
		stopVite();
		process.exit(prepareExit ?? 1);
	}
}

log("starting the shell");
const shell = spawn([bun, ...electrobun, "dev", "--env=dev"], {
	cwd: desktopDir,
	stdout: "inherit",
	stderr: "inherit",
	env: { ...process.env, ETA_CLIENT_URL: devUrl } as Record<string, string>,
});

await shell.exited;
stopVite();
