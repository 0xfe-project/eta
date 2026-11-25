/**
 * An ACP agent that starts a child before it answers, as a Windows shim does: the child is not tied
 * to its parent, so it lives on after the agent is ended, and keeps the directory both were started
 * in. The agent itself is the fake one. `FAKE_ACP_DIR/holder.pid` says which process the child is.
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import "./fake-agent";

const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
  detached: true,
});
writeFileSync(
  join(process.env.FAKE_ACP_DIR ?? process.cwd(), "holder.pid"),
  String(holder.pid),
);
