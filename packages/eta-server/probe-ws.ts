const port = Number(process.argv[2] ?? 50000);
const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
let target = "";
const timer = setTimeout(() => { done(); }, 4000);
function done() { clearTimeout(timer); if (!socket.url.includes("closed")) socket.close(); }
socket.addEventListener("message", (event) => {
	const m = JSON.parse(String((event as MessageEvent).data)) as Record<string, unknown>;
	if (m.type === "hello") {
		const list = (m.sessions ?? []) as { name: string; title?: string }[];
		console.log("sessions:", list.map((s) => `${s.name}${s.title ? `(${s.title.slice(0, 8)})` : ""}`).join(" "));
	}
	if (JSON.stringify(m).includes("ui-mtxroh7g") && typeof m.session === "string") {
		target = m.session;
		const view = (m.view ?? {}) as { loops?: unknown[] };
		console.log("frame from", target, "loops:", JSON.stringify(view.loops ?? "no loops key"));
	}
});
socket.addEventListener("open", () => {});
await new Promise((r) => setTimeout(r, 1200));
if (target !== "") {
	socket.send(JSON.stringify({ type: "loopToggle", session: target, id: "ui-mtxroh7g", paused: true }));
	await new Promise((r) => setTimeout(r, 600));
}
console.log(target === "" ? "loop not in this server's views" : `paused via ${port}`);
socket.close();
