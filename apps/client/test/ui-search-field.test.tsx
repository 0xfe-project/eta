import { expect, open, test } from "nsh/test";

test("SearchField updates query and clears on clear button press", async () => {
  const app = await open("./fixtures/ui-search-field.tsx", {
    width: 600,
    height: 400,
    locale: "en-US",
  });
  expect(app.shows("text:q:")).toBe(true);
  await app.type("label:Search items", "eta");
  expect(app.shows("text:q:eta")).toBe(true);
  await app.press("label:Close");
  expect(app.shows("text:q:")).toBe(true);
});
