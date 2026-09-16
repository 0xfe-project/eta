import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
	if (value !== undefined) env[key] = value;
}

// Codex and other packaged Node/PowerShell hosts can put PowerShell 7 modules
// first on PSModulePath. Windows PowerShell 5.1 then finds a module it cannot
// load instead of its bundled Compress-Archive, which Hutch needs for the setup
// archive. Pin the Windows PowerShell module roots for this build.
if (process.platform === "win32") {
	const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
	const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
	const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
	env.PSModulePath = [
		join(home, "Documents", "WindowsPowerShell", "Modules"),
		join(programFiles, "WindowsPowerShell", "Modules"),
		join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "Modules"),
	].join(";");
}

const run = (args: string[]) => Bun.spawn([process.execPath, ...args], {
	cwd: desktopDir,
	stdout: "inherit",
	stderr: "inherit",
	env,
});

const client = await run(["run", "client"]).exited;
if (client !== 0) process.exit(client ?? 1);
const build = await run(["x", "--bun", "electrobun", "build", "--env=stable"]);
process.exit(await build.exited);
