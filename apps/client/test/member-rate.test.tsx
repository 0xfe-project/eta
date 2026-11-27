import { expect, open, test } from "nsh/test";

const fixture = "./fixtures/member-rate.tsx";
const rate = "id:rate:s-ada";

test("a working member shows its output speed beside its status, an idle member none", async () => {
  const app = await open(fixture, {
    width: 1440,
    height: 900,
    locale: "en-US",
  });
  const spoken = () => app.accessibility(rate)?.name ?? null;
  expect(spoken()).toBe("about 38 tok/s");
  expect(app.texts()).toContain("≈");
  expect(app.count("id:rate:s-bo")).toBe(0);
  await app.press("label:Generation ends");
  await app.waitUntil(() => !app.texts().includes("≈"));
  expect(spoken()).toBe("42 tok/s");
  await app.press("label:Generation starts");
  expect(app.count(rate)).toBe(0);
  await app.press("label:First estimate");
  expect(spoken()).toBe("about 7 tok/s");
  expect(app.texts()).toContain("≈");
  await app.press("label:Run ends");
  expect(app.count(rate)).toBe(0);
});

test("a long member name and the steps button never squeeze the speed", async () => {
  const app = await open(fixture, {
    width: 1440,
    height: 900,
    locale: "en-US",
  });
  const shown = app.layout(rate)!;
  expect(app.texts()).toContain("Steps 39/39");
  expect(shown.hidden).toBe(false);
  expect(shown.clipped).toBe(false);
  expect(shown.width).toBeGreaterThanOrEqual(50);
});
