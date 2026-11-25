import { expect, open, test } from "nsh/test";

test("Tooltip and hint attach cleanly to target views", async () => {
  const app = await open("./fixtures/ui-tooltip.tsx", {
    width: 600,
    height: 400,
  });
  expect(app.shows("text:Hover target")).toBe(true);
  expect(app.shows("text:Rich target")).toBe(true);
});
