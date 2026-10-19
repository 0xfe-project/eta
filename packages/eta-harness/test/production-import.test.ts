import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("default harness import excludes Node adapters and local filesystem/process modules", () => {
  const output = execFileSync(
    "bun",
    [fileURLToPath(new URL("./production-import.smoke.mjs", import.meta.url))],
    {
      encoding: "utf8",
    },
  );
  expect(output).toContain("Harness production import passed");
});
