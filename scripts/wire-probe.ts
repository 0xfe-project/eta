/**
 * Wire probe: what the browser tab actually pays per second.
 *
 * Connects as an ordinary client, so it sees exactly the frames the GUI would —
 * whole views, patches, the sidebar list, the dev ring — and prints the byte
 * budget by channel and by frame kind. Run it while a session is answering:
 *
 *   bun packages/eta-server/scripts/wire-probe.ts 20
 *
 * The number to watch is `view patch` bytes against `view whole`, and the frames
 * per second: a frame that carries the transcript again on every token is the bug
 * this exists to catch.
 */

const seconds = Number(process.argv[2] ?? 20);
const port = Number(process.argv[3] ?? process.env.PORT ?? 3000);
// Patches are only sent to a wire where every client asked for them, so a probe
// that wants to see them has to ask. Run with NOPATCH=1 to watch as a pre-split
// client would: whole frames, and patches switched off for everyone.
const url = `ws://127.0.0.1:${port}/ws${process.env.NOPATCH === undefined ? "?viewPatch" : ""}`;

type Row = { frames: number; bytes: number };
const rows = new Map<string, Row>();
const timeline: number[] = [];
const started = Date.now();

const record = (key: string, bytes: number): void => {
	const row = rows.get(key) ?? { frames: 0, bytes: 0 };
	row.frames += 1;
	row.bytes += bytes;
	rows.set(key, row);
	const second = Math.floor((Date.now() - started) / 1000);
	timeline[second] = (timeline[second] ?? 0) + bytes;
};

const ws = new WebSocket(url);
ws.addEventListener("message", (event) => {
	const raw = String((event as MessageEvent).data);
	const frame = JSON.parse(raw) as Record<string, unknown>;
	const channel = typeof frame.channel === "string" ? frame.channel : undefined;
	let key = `type:${typeof frame.type === "string" ? frame.type : "?"}`;
	if (channel === "view") key = "view" in frame ? "view whole" : "view patch";
	else if (channel === "dev") key = "dev";
	else if (channel === "agent") key = "agent";
	record(key, raw.length);
	if (channel === "view" && "view" in frame) {
		const view = frame.view as Record<string, unknown>;
		// What this frame would have cost once the client can fold patches: the same
		// frame with the transcript left out. Both numbers on one line, so the saving
		// is readable without a second run, including while patches are switched off
		// because some tab on the wire cannot fold them yet.
		const transcript = ["messages", "systems", "thinking"].reduce(
			(sum, field) => sum + (JSON.stringify(view[field])?.length ?? 0),
			0,
		);
		const asPatch = Math.max(0, raw.length - transcript);
		const sizes: [string, number][] = Object.keys(view)
			.filter((field) => field !== "messages" && field !== "systems" && field !== "thinking")
			.map((field) => [field, JSON.stringify(view[field])?.length ?? 0]);
		const biggest = sizes.sort((a, b) => b[1] - a[1]).slice(0, 3);
		console.log(
			`whole view frame ${(raw.length / 1024).toFixed(0)}KB  transcript ${(transcript / 1024).toFixed(0)}KB` +
				`  as patch ${(asPatch / 1024).toFixed(1)}KB (${(100 * (asPatch / raw.length)).toFixed(1)}%)` +
				biggest.map(([field, size]) => `  ${field}=${(size / 1024).toFixed(1)}KB`).join(""),
		);
	}
});

setTimeout(() => {
	const elapsed = (Date.now() - started) / 1000;
	console.log(`\n${elapsed.toFixed(0)}s on ${url}`);
	for (const [key, row] of [...rows].sort((a, b) => b[1].bytes - a[1].bytes)) {
		console.log(
			`${key.padEnd(12)} ${String(row.frames).padStart(5)} frames  ${(row.bytes / 1024 / elapsed).toFixed(0)} KB/s  avg ${(row.bytes / row.frames / 1024).toFixed(1)}KB`,
		);
	}
	const total = [...rows.values()].reduce((sum, row) => sum + row.bytes, 0);
	console.log(`${"TOTAL".padEnd(12)} ${[...rows.values()].reduce((sum, row) => sum + row.frames, 0)} frames  ${(total / 1024 / elapsed).toFixed(0)} KB/s`);
	console.log(`per second (KB): ${timeline.map((bytes) => (bytes / 1024).toFixed(0)).join(" ")}`);
	ws.close();
	process.exit(0);
}, seconds * 1000);
