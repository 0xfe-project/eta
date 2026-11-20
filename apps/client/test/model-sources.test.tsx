import { expect, open, test } from "nsh/test";

for (const [width, height] of [
  [1440, 900],
  [1024, 768],
  [390, 844],
]) {
  test(`monthly usage and balance appear in the source summary at ${width}`, async () => {
    const app = await open("./fixtures/model-sources.tsx", {
      width,
      height,
      locale: "en-US",
    });
    const row =
      width === 390
        ? "Lab · codex · active"
        : "Lab · codex · active · Monthly · 37.5% used";
    expect(app.shows(`label:${row}`)).toBe(true);
    await app.press(`label:${row}`);
    expect(app.texts()).toContain("Lab · Monthly · 37.5% used");
    expect(app.texts()).toContain("Reset time unavailable");
    expect(app.texts().join(" ")).not.toContain("88%");
    expect(app.texts().join(" ")).not.toContain("79%");
    await app.press("Refresh subscriptions");
    expect(app.texts()).toContain("llm.refresh");
    await app.press("Connection");
    expect(app.shows("text:Lab · Monthly · 37.5% used")).toBe(width !== 390);
    await app.press("Back >> nth=0");
    await app.press("Source");
    await app.press("Check balance");
    await app.waitFor("text:Available account balance · USD 0.00");
    expect(app.texts()).toContain("Some values are unavailable");
    await app.press("Check");
    expect(app.texts()).toContain("Working");
    await app.press("label:model");
    expect(app.texts()).toContain("providers.save");
    await app.press("Connection");
    expect(app.shows("text:Available account balance · USD 0.00")).toBe(
      width !== 390,
    );
  });
}

test("keeps repeated labels, multiple windows, failed and weekly-only accounts separate", async () => {
  const app = await open("./fixtures/model-sources.tsx", {
    width: 1024,
    height: 768,
    urlScheme: "eta://fixture/multi",
    locale: "en-US",
  });
  await app.press("label:Other · codex · active");
  for (const line of [
    "Lab (one) · Monthly · 37.5% used",
    "Lab (one) · Monthly · >99.9% used",
    "Lab (two) · Monthly · 0% used",
    "Sign in again",
    "No monthly window reported",
  ])
    expect(app.texts()).toContain(line);
});
