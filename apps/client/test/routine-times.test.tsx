import { expect, open, test } from "nsh/test";

// The routines list and its form, on the headless engine — the native runtime, where
// `Intl.RelativeTimeFormat` and `Intl.supportedValuesOf` are still missing. A row whose next run
// is minutes away used to throw while it drew, and the host's read loop took that for a lost
// connection; the page is expected to draw its time words here, in both languages.

const sizes = [
  ["desktop", 1280, 760],
  ["phone", 390, 844],
] as const;

for (const [name, width, height] of sizes) {
  test(`${name}: a routine with a next time says how far off it is`, async () => {
    const app = await open("./fixtures/routine-times.tsx", {
      platform: width < 600 ? "ios" : "macos",
      width,
      height,
      locale: "en-US",
    });
    await app.waitFor("text:Weekly digest");
    const texts = app.texts();
    expect(
      texts.filter((text) => /^Next · in \d+ minutes?$/.test(text)),
    ).toHaveLength(1);
    expect(
      texts.filter((text) => /^Next · in \d+ hours?$/.test(text)),
    ).toHaveLength(1);
    expect(texts.some((text) => /Connection lost/i.test(text))).toBe(false);
  });
}

test("in Chinese the same rows say their times in Chinese", async () => {
  const app = await open("./fixtures/routine-times.tsx", {
    platform: "macos",
    width: 1280,
    height: 760,
    locale: "zh-CN",
  });
  await app.waitFor("text:Weekly digest");
  const texts = app.texts();
  expect(texts.filter((text) => /^下次 · \d+ 分钟后$/.test(text))).toHaveLength(
    1,
  );
  expect(texts.filter((text) => /^下次 · \d+ 小时后$/.test(text))).toHaveLength(
    1,
  );
});

test("the form lists the time zones the runtime knows, the device's own included", async () => {
  const app = await open("./fixtures/routine-times.tsx", {
    platform: "macos",
    width: 1280,
    height: 760,
    locale: "en-US",
  });
  await app.waitFor("label:New routine");
  await app.press("label:New routine");
  await app.waitFor("text:Time zone");
  // The picker starts on the device's own zone, which is all the native runtime can list.
  const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  expect(app.shows(`text:${zone}`)).toBe(true);
});
