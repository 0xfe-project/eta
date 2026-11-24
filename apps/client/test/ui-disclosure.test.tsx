import { expect, open, test } from "nsh/test";

test("Disclosure toggles content visibility on trigger press", async () => {
  const app = await open("./fixtures/ui-disclosure.tsx", {
    width: 600,
    height: 400,
  });
  expect(app.shows("text:Expanded content")).toBe(false);
  await app.press("label:More details");
  expect(app.shows("text:Expanded content")).toBe(true);
  await app.press("label:More details");
  expect(app.shows("text:Expanded content")).toBe(false);
});
