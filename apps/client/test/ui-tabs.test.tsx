import { expect, open, test } from "nsh/test";

test("Tabs and Segmented switch active selection", async () => {
  const app = await open("./fixtures/ui-tabs.tsx", {
    width: 600,
    height: 400,
  });
  expect(app.shows("text:tab:models view:board")).toBe(true);
  await app.press("label:Connection");
  expect(app.shows("text:tab:connection view:board")).toBe(true);
  await app.press("label:Plan");
  expect(app.shows("text:tab:connection view:plan")).toBe(true);
});
