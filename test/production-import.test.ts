import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("imports the production entry without test dependencies", () => {
	const output = execFileSync("bun", [fileURLToPath(new URL("./production-import.smoke.mjs", import.meta.url))], {
		encoding: "utf8",
	});
	expect(output).toContain("Production import smoke passed");
});

it.each(["@eta/core/session", "@eta/core/storage"])("imports %s without kernel or model runtime", (entry) => {
	const output = execFileSync(
		"bun",
		[fileURLToPath(new URL("./session-storage-import.smoke.mjs", import.meta.url)), entry],
		{ encoding: "utf8" },
	);
	expect(output).toContain("Focused entry import passed");
});
