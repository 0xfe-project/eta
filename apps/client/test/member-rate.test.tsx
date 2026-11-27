import { expect, open, test } from "nsh/test";

const fixture = "./fixtures/member-rate.tsx";
const rates = (texts: string[]) =>
  texts.filter((text) => text.includes("tok/s")).map((text) => text.trim());

test("a working member shows its output speed beside its status, an idle member none", async () => {
  const app = await open(fixture, {
    width: 1440,
    height: 900,
    locale: "en-US",
  });
  expect(rates(app.texts())).toEqual(["≈38 tok/s"]);
  await app.press("label:Generation ends");
  expect(rates(app.texts())).toEqual(["42 tok/s"]);
  await app.press("label:Generation starts");
  expect(rates(app.texts())).toEqual([]);
  await app.press("label:First estimate");
  expect(rates(app.texts())).toEqual(["≈7 tok/s"]);
  await app.press("label:Run ends");
  expect(rates(app.texts())).toEqual([]);
});

test("a long member name and the steps button never squeeze the speed", async () => {
  const app = await open(fixture, {
    width: 1440,
    height: 900,
    locale: "en-US",
  });
  const rate = app.layout("text:≈38 tok/s")!;
  expect(app.texts()).toContain("Steps 39/39");
  expect(rate.hidden).toBe(false);
  expect(rate.clipped).toBe(false);
  expect(rate.width).toBeGreaterThanOrEqual(50);
});
