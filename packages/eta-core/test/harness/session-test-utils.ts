import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, posix, relative, sep } from "node:path";
import { afterEach } from "vitest";

const tempDirs: string[] = [];

export function createTempDir(): string {
	const dir = join(tmpdir(), `pi-agent-session-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	tempDirs.push(dir);
	return dir;
}

/** Windows tests execute through Git Bash, whose /tmp view differs from the native path. */
export function gitBashPath(path: string): string {
	if (process.platform !== "win32") return path;
	const canonical = realpathSync.native(path);
	const temp = realpathSync.native(tmpdir());
	const rel = relative(temp, canonical);
	if (rel === "" || isAbsolute(rel) || rel.startsWith("..")) return canonical.replaceAll("\\", "/");
	return posix.join("/tmp", ...rel.split(sep));
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop()!;
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
	}
});
