import { expect, open, test } from "nsh/test";

for (const [width, height] of [
  [1440, 900],
  [1024, 768],
  [390, 844],
  [320, 640],
]) {
  test(`reads the visible list once and keeps details free of billing controls at ${width}`, async () => {
    const app = await open("./fixtures/model-sources.tsx", {
      width,
      height,
      locale: "en-US",
    });
    await app.waitFor("text:USD 1");
    expect(app.texts()).toContain("CNY 0.00");
    expect(app.texts()).toContain("0% used this month");
    await app.press("label:Lab · codex · active · 37.5% used this month");
    expect(app.texts()).not.toContain("37.5% used this month");
    expect(app.texts()).not.toContain("Refresh subscriptions");
    await app.press("Connection");
    expect(app.texts()).toContain("Lab · Team · active");
    expect(app.texts()).toContain("visits 1");
    await app.press("Back >> nth=0");
    await app.waitFor("text:USD 2");
    await app.press("label:Source · USD 2 · CNY 0.00");
    expect(app.texts()).not.toContain("Check balance");
    await app.press("Check");
    expect(app.texts()).toContain("Working");
    await app.press("label:model");
    expect(app.texts()).toContain("providers.save");
  });
}

for (const mode of ["legacy", "offline"]) {
  test(`silently leaves the list empty for ${mode}`, async () => {
    const app = await open("./fixtures/model-sources.tsx", {
      urlScheme: `eta://fixture/${mode}`,
      locale: "en-US",
    });
    expect(app.shows("label:Source")).toBe(true);
    expect(app.texts().join(" ")).not.toContain("%");
    expect(app.texts()).not.toContain("CNY 0.00");
    expect(app.texts().includes("visits 1")).toBe(mode === "offline");
  });
}

for (const mode of ["reentry", "host"]) {
  test(`discards the previous reply after ${mode} and drops a rotated row`, async () => {
    const app = await open("./fixtures/model-sources.tsx", {
      width: 1024,
      height: 768,
      urlScheme: "eta://fixture/race",
      locale: "en-US",
    });
    await app.waitFor("text:visits 1");
    if (mode === "host") await app.press("Switch Host");
    else {
      await app.press("Source");
      await app.press("Back >> nth=0");
    }
    await app.waitFor("text:USD 2");
    await app.press("Release first");
    expect(app.texts()).toContain("USD 2");
    expect(app.texts()).not.toContain("USD 1");
    await app.press("Rotate");
    expect(app.texts()).not.toContain("USD 2");
    expect(app.texts()).toContain("visits 2");
    expect(app.texts()).toContain("37.5% used this month");
  });
}

test("a late reply cannot populate a source removed and recreated during the visit", async () => {
  const app = await open("./fixtures/model-sources.tsx", {
    width: 1024,
    height: 768,
    urlScheme: "eta://fixture/race",
    locale: "en-US",
  });
  await app.waitFor("text:visits 1");
  await app.press("Remove row");
  expect(app.shows("label:Source")).toBe(false);
  await app.press("Restore row");
  await app.press("Release first");
  await app.waitFor("text:37.5% used this month");
  expect(app.shows("label:Source")).toBe(true);
  expect(app.texts()).not.toContain("USD 1");
  expect(app.texts()).toContain("visits 1");
});
