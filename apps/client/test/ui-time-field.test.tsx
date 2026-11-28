import { expect, open, test } from "nsh/test";

test("TimeField renders formatted time segments and reports what is typed", async () => {
  const app = await open("./fixtures/ui-time-field.tsx", {
    width: 600,
    height: 400,
  });
  expect(app.value("label:Run time")).toBe("09:30");
  expect(app.shows("text:09")).toBe(true);
  expect(app.shows("text:30")).toBe(true);
  await app.type("label:Run time", "1045");
  expect(app.shows("text:10")).toBe(true);
  expect(app.shows("text:45")).toBe(true);
  expect(app.shows("text:at:10:45")).toBe(true);
});
