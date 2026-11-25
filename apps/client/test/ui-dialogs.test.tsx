import { expect, open, test } from "nsh/test";

test("ConfirmDialog and FieldDialog complete confirm and save flows", async () => {
  const app = await open("./fixtures/ui-dialogs.tsx", {
    width: 800,
    height: 600,
    locale: "en-US",
  });
  await app.press("Ask confirm");
  expect(app.shows("text:This cannot be undone.")).toBe(true);
  await app.press("Delete");
  expect(app.shows("text:confirmed:true saved:")).toBe(true);

  await app.press("Ask rename");
  await app.type("label:Name", "Beta");
  await app.press("Save");
  expect(app.shows("text:confirmed:true saved:AlphaBeta")).toBe(true);
});
