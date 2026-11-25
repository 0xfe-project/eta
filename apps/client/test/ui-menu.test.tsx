import { expect, open, test } from "nsh/test";

test("ActionMenu opens and dispatches ActionItem selection", async () => {
  const app = await open("./fixtures/ui-menu.tsx", {
    width: 600,
    height: 400,
  });
  expect(app.shows("text:chosen:none")).toBe(true);
  await app.press("label:Options");
  await app.waitFor("label:Rename");
  await app.press("label:Rename");
  await app.waitFor("text:chosen:Rename");
});
