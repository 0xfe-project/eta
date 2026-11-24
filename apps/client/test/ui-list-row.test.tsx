import { expect, open, test } from "nsh/test";

test("ListRow and SectionHeader render cleanly and handle presses", async () => {
  const app = await open("./fixtures/ui-list-row.tsx", {
    width: 600,
    height: 400,
  });
  expect(app.shows("text:Preferences")).toBe(true);
  expect(app.shows("text:Client options")).toBe(true);
  await app.press("label:Appearance");
  expect(app.shows("text:opened:appearance")).toBe(true);
});
