import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Ship the service runtime with the desktop app; users do not need Bun on PATH.
const directory = fileURLToPath(new URL("../../eta-server/artifacts/desktop/", import.meta.url));
await mkdir(directory, { recursive: true });
const binary = `${directory}${process.platform === "win32" ? "eta-server.exe" : "eta-server"}`;
const entry = fileURLToPath(new URL("../../eta-server/src/remote-main.ts", import.meta.url));
const build = Bun.spawn([process.execPath, "build", entry, "--compile", `--outfile=${binary}`], {
	stdout: "inherit", stderr: "inherit",
});
if (await build.exited !== 0) throw new Error("Could not build the desktop eta service");
