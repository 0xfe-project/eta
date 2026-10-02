import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("imports the production entry without test dependencies", () => {
	const output = execFileSync("bun", [fileURLToPath(new URL("./production-import.smoke.mjs", import.meta.url))], {
		encoding: "utf8",
	});
	expect(output).toContain("Production import smoke passed");
});
