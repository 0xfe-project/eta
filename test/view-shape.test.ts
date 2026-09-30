/**
 * The seam between the harness's view and the wire's (S16).
 *
 * They are the same three fields — core, sections, revisions — and this file is where
 * that claim is checked rather than assumed. It is a compile-time assertion with a
 * runtime sanity check on top: if either side quietly grows a required field, this stops
 * building, which is cheaper than a client that receives frames it cannot read.
 */
import { MemoryStorage } from "@eta/core";
import { fakeModels } from "@eta/core/testing";
import { openSession } from "@eta/harness";
import type { SessionView, SessionViewPatch } from "@eta/wire";
import { viewDiff, viewSection } from "@eta/wire";
import { describe, expect, it } from "vitest";

describe("the harness snapshot is what the wire says a view is", () => {
	it("assigns, reads by section name, and diffs", async () => {
		const session = await openSession({
			storage: new MemoryStorage(),
			models: fakeModels([]) as never,
			sessionId: "eta-seam",
			cwd: "/work",
		});
		// No cast: the shapes have to line up on their own.
		const snapshot: SessionView = session.view.snapshot();
		expect(snapshot.core.session).toBe("eta-seam");
		expect(snapshot.core.cwd).toBe("/work");
		expect(Object.keys(snapshot.revisions).length).toBeGreaterThan(0);

		// A client that holds nothing gets the whole view; one that is current gets nothing.
		expect(viewDiff(undefined, snapshot)).toBe("full");
		expect(viewDiff(snapshot.revisions, session.view.snapshot())).toBeUndefined();

		// Reading a section by name is typed and admits absence.
		expect(viewSection(snapshot, "transcript")?.messages).toEqual([]);
		expect(viewSection(snapshot, "goal")).toBeUndefined();

		// And a patch is what the wire would send for a change.
		session.kernel.tasks.create("a task worth showing");
		const changed = session.view.snapshot();
		const patch = viewDiff(snapshot.revisions, changed);
		expect(patch).not.toBe("full");
		const typed = patch as SessionViewPatch;
		expect(Object.keys(typed.sections)).toEqual(["tasks"]);

		await session.kernel.dispose();
		session.stop();
	});
});
