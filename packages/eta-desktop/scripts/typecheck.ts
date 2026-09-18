import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), "..");
if (!existsSync(join(desktopDir, ".hutch", "devkit"))) {
	console.log("eta-desktop: skipped, run `bun run prepare:sdk`");
	process.exit(0);
}

const tsc = Bun.spawn([process.execPath, "x", "tsc", "--noEmit"], {
	cwd: desktopDir,
	stdout: "inherit",
	stderr: "inherit",
});
process.exit(await tsc.exited);
