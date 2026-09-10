// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { queryId } from "./dom.ts";
import { click, render } from "./render.tsx";
import { LogRail } from "../src/features/sessions/log-rail.tsx";

describe("dev rail json dialog", () => {
	it("opens a dialog with the full frame payload on click", () => {
		const frames = [{ ts: 1_700_000_000_000, session: "s", category: "state", action: "set", data: { key: "x".repeat(500) } }];
		render(<LogRail frames={frames} />);
		click("log-frame");
		expect(queryId("log-frame-dialog")).not.toBeNull();
	});
});
