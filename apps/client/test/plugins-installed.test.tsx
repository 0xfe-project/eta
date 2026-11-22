import { expect, open, test } from "nsh/test";

test("each installed plugin card shows its own Enabled switch, and an off one says so", async () => {
  const app = await open("./fixtures/plugins-installed.tsx", { width: 1100, height: 700 });
  expect(app.shows("on-plugin")).toBe(true);
  expect(app.shows("off-plugin")).toBe(true);
  expect(app.shows("Enabled")).toBe(true);
  expect(app.shows("Off for all agents")).toBe(true);
});
