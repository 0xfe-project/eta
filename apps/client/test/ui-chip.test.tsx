import { expect, open, test } from "nsh/test";

test("Chip handles selection and removal", async () => {
  const app = await open("./fixtures/ui-chip.tsx", {
    width: 600,
    height: 400,
  });
  expect(app.shows("text:active:design count:2")).toBe(true);
  await app.press("label:client");
  expect(app.shows("text:active:client count:2")).toBe(true);
  await app.press("label:Remove design");
  expect(app.shows("text:active:client count:1")).toBe(true);
});
