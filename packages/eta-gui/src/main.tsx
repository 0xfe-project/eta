import { render } from "@gpuix/react";
import { EtaApp } from "./app.tsx";
import { fakeFeed } from "./fake.ts";

const isEntryPoint =
	typeof import.meta.main === "boolean" ? import.meta.main : typeof window !== "undefined";

if (isEntryPoint) {
	const feed = fakeFeed();
	render(<EtaApp sessions={feed.sessions} view={feed.view} dev={feed.dev} />, {
		title: "eta",
		width: 1280,
		height: 800,
		focus: typeof process === "undefined" || process.env.GPUIX_BACKGROUND !== "1",
	});
}
