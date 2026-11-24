import { expect, open, test } from "nsh/test";

test("Field and FormField render label, hint, and validation error", async () => {
  const app = await open("./fixtures/ui-input.tsx", {
    width: 600,
    height: 400,
  });
  expect(app.shows("text:Project name")).toBe(true);
  expect(app.shows("text:Use at least 3 characters")).toBe(true);
  await app.type("label:Project name", "ab");
  expect(app.shows("text:Too short")).toBe(true);
  await app.type("label:Project name", "eta");
  expect(app.shows("text:Too short")).toBe(false);
  expect(app.shows("text:Use at least 3 characters")).toBe(true);
});
