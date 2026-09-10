import type { ServerWebSocket } from "bun";
import { homedir } from "node:os";
import { join } from "node:path";
import { statSync } from "node:fs";

export type TermSocket = ServerWebSocket<{ kind?: "ws" | "term"; socketId?: number; shell?: unknown }>;

export interface ShellHandle {
	proc: BunShell;
	alive: boolean;
}

type BunTerminal = { write(data: string | Uint8Array): void; resize: (cols: number, rows: number) => void };
type BunShell = ReturnType<typeof Bun.spawn> & { terminal?: BunTerminal };

type StartFrame = { op: "start"; cols: number; rows: number; cwd?: string };

/**
 * One interactive pty per /term websocket, bridged straight to an xterm.js
 * client: shell output rides as binary frames, control (start/input/resize)
 * as JSON text frames.
 */
export class TermRegistry {
	open(socket: TermSocket): void {
		socket.data.kind = "term";
		// Bun's default `idleTimeout` is 120s of silence, and a terminal the user is
		// thinking in is silent by definition — a dropped socket would cost them
		// their editor. bun-types has no `ws.idleTimeout` field yet, so disarm it
		// per connection. (A/B'd over 140s: both survive today; this keeps intent
		// explicit rather than relying on that.)
		const withTimeout = socket as unknown as { timeout?: (seconds: number) => void };
		withTimeout.timeout?.(0);
	}

	message(socket: TermSocket, raw: Buffer | string): void {
		if (typeof raw !== "string") return;
		let frame: StartFrame | { op: "input"; data: string } | { op: "resize"; cols: number; rows: number };
		try {
			frame = JSON.parse(raw);
		} catch {
			return;
		}
		if (frame.op === "start") {
			this.kill(socket);
			const shell = process.env.SHELL ?? "/bin/zsh";
			const handle: ShellHandle = { proc: undefined as unknown as BunShell, alive: true };
			socket.data.shell = handle;
			const requested =
				frame.cwd === undefined
					? undefined
					: frame.cwd === "~"
						? homedir()
						: frame.cwd.startsWith("~/")
							? join(homedir(), frame.cwd.slice(2))
							: frame.cwd;
			const proc = Bun.spawn([shell, "-i"], {
				cwd: requested !== undefined && directoryExists(requested) ? requested : homedir(),
				env: { ...process.env, TERM: "xterm-256color" },
				terminal: {
					cols: frame.cols,
					rows: frame.rows,
					data: (_terminal, data) => {
						if (handle.alive && socket.readyState === 1) socket.send(data);
					},
				},
			}) as unknown as BunShell;
			handle.proc = proc;
			void proc.exited.then((code: number) => {
				handle.alive = false;
				if (socket.readyState === 1) socket.send(JSON.stringify({ event: "exit", code }));
			});
			return;
		}
		const shell = socket.data.shell as ShellHandle | undefined;
		if (shell === undefined) return;
		if (frame.op === "input") {
			shell.proc.terminal?.write(frame.data);
			return;
		}
		if (frame.op === "resize") shell.proc.terminal?.resize(frame.cols, frame.rows);
	}

	close(socket: TermSocket): void {
		this.kill(socket);
	}

	private kill(socket: TermSocket): void {
		const shell = socket.data.shell as ShellHandle | undefined;
		if (shell === undefined) return;
		socket.data.shell = undefined;
		shell.alive = false;
		try {
			shell.proc.kill();
		} catch {
			/* already gone */
		}
	}
}

function directoryExists(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}
