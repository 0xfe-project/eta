// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { queryId } from "./dom.ts";
import { click, render } from "./render.tsx";
import { DevRail } from "../src/features/sessions/dev-rail.tsx";

describe("dev rail json dialog", () => {
	it("opens a dialog with the full frame payload on click", () => {
		const frames = [{ ts: 1_700_000_000_000, session: "s", category: "state", action: "set", data: { key: "x".repeat(500) } }];
		render(<DevRail frames={frames} />);
		click("dev-frame");
		expect(queryId("dev-frame-dialog")).not.toBeNull();
	});
});
