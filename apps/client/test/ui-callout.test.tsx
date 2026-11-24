import { expect, open, test } from "nsh/test";

test("Callout and WarningLine render semantic notices with alert semantics", async () => {
  const app = await open("./fixtures/ui-callout.tsx", {
    width: 600,
    height: 400,
  });
  expect(app.shows("text:Connection failed")).toBe(true);
  expect(app.shows("text:Host refused the token.")).toBe(true);
  expect(app.shows("text:Sync ready")).toBe(true);
  expect(app.shows("text:Missing model configuration")).toBe(true);
});
