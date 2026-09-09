import { startServer } from "./server.ts";

const server = await startServer({
	port: Number(process.env.PORT ?? 3000),
	hostname: process.env.ETA_HOST ?? "127.0.0.1",
});

console.log(`eta-server on http://${process.env.ETA_HOST ?? "127.0.0.1"}:${server.port} (model: ${process.env.ANTHROPIC_API_KEY ? "anthropic" : "faux echo"})`);
