// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { DevRail } from "../src/features/sessions/dev-rail.tsx";

describe("dev rail json dialog", () => {
	it("opens a dialog with the full frame payload on click", () => {
		const frames = [{ ts: 1_700_000_000_000, session: "s", category: "state", action: "set", data: { key: "x".repeat(500) } }];
		const view = render(<DevRail frames={frames} />);
		fireEvent.click(view.getByTestId("dev-frame"));
		expect(view.queryByTestId("dev-frame-dialog")).not.toBeNull();
	});
});
