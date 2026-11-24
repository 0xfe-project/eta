import { expect, open, test } from "nsh/test";

test("TimeField renders formatted time segments", async () => {
  const app = await open("./fixtures/ui-time-field.tsx", {
    width: 600,
    height: 400,
  });
  expect(app.shows("text:at:09:30")).toBe(true);
});
