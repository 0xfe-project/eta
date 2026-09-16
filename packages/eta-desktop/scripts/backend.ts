import { mkdir } from "node:fs/promises";

// Ship the service runtime with the desktop app; users do not need Bun on PATH.
const directory = new URL("../../eta-server/artifacts/desktop/", import.meta.url).pathname;
await mkdir(directory, { recursive: true });
const binary = `${directory}${process.platform === "win32" ? "eta-server.exe" : "eta-server"}`;
const entry = new URL("../../eta-server/src/remote-main.ts", import.meta.url).pathname;
const build = Bun.spawn([process.execPath, "build", entry, "--compile", `--outfile=${binary}`], {
	stdout: "inherit", stderr: "inherit",
});
if (await build.exited !== 0) throw new Error("Could not build the desktop eta service");
