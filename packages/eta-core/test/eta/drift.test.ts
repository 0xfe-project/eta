import { describe, expect, it } from "vitest";
import {
	DoomLoopDetector,
	LoopDetector,
	isSimilar,
	levenshtein,
	sorensenDice,
	jaroWinkler,
	tailRepetition,
} from "../../src/eta/drift.ts";

describe("doom loop detector", () => {
	it("fires on the third identical call", () => {
		const d = new DoomLoopDetector();
		const args = { path: "/tmp/a" };
		expect(d.observe("read_file", args)).toBe(false);
		expect(d.observe("read_file", args)).toBe(false);
		expect(d.observe("read_file", args)).toBe(true);
	});

	it("ignores different args or tools", () => {
		const d = new DoomLoopDetector();
		const a = { path: "/tmp/a" };
		const b = { path: "/tmp/b" };
		expect(d.observe("read_file", a)).toBe(false);
		expect(d.observe("read_file", b)).toBe(false);
		expect(d.observe("write_file", a)).toBe(false);
		expect(d.observe("read_file", a)).toBe(false);
	});

	it("reset clears counts", () => {
		const d = new DoomLoopDetector();
		const args = { path: "/tmp/a" };
		d.observe("read_file", args);
		d.observe("read_file", args);
		d.reset();
		expect(d.observe("read_file", args)).toBe(false);
	});
});

describe("tail repetition", () => {
	it("finds repeated trailing lines", () => {
		const unit = "I will now read the file to understand the code.";
		const content = `Some reasoning.\n${`${unit}\n`.repeat(6)}`;
		expect(tailRepetition(content, 4)).toBe(unit);
	});

	it("ignores short or varied output", () => {
		expect(tailRepetition("ok\nok\nok\nok\nok", 3)).toBeUndefined();
		const varied = Array.from({ length: 6 }, (_, i) => `step ${i} does something different enough`).join("\n");
		expect(tailRepetition(varied, 3)).toBeUndefined();
		expect(tailRepetition("short", 3)).toBeUndefined();
	});
});

describe("single-message loop", () => {
	it("detects near-identical consecutive outputs", () => {
		const d = new LoopDetector();
		const a = "I will now read src/main.rs to understand the entry point and continue.";
		const b = "I will now read src/main.rs to understand the entry point and continue!";
		const c = "Now let me run the test suite to verify the change.";
		expect(d.observe(a)).toBe(false);
		expect(d.observe(b)).toBe(false);
		expect(d.observe(b)).toBe(true);
		d.reset();
		expect(d.observe(a)).toBe(false);
		expect(d.observe(c)).toBe(false);
	});
});

describe("similarity metrics", () => {
	it("basics", () => {
		expect(levenshtein("kitten", "sitting")).toBe(3);
		expect(isSimilar("abc", "abc")).toBe(true);
		expect(isSimilar("hello world", "hello world!")).toBe(true);
		expect(jaroWinkler("DWAYNE", "DUANE") > 0.8).toBe(true);
		expect(sorensenDice("abcd", "abcd")).toBe(1);
	});
});
