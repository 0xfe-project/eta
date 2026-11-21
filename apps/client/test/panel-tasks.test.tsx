import { expect, open, test } from "nsh/test";

// Each row of the Tasks tab says, under its title, its number, who runs it and when it last
// moved. The headless engine is the native runtime (no `Intl.RelativeTimeFormat`), where the
// line used to throw and come out empty on the macOS, Linux and Windows apps.
const sizes = [
  ["desktop", 1440, 900],
  ["tablet", 1024, 768],
  ["phone", 390, 844],
] as const;

for (const [name, width, height] of sizes) {
  test(`${name}: every task row has its number, executor and time`, async () => {
    const app = await open("./fixtures/panel-tasks.tsx", {
      width,
      height,
      locale: "en-US",
    });
    await app.waitFor("text:Build the login API");
    const texts = app.texts();
    expect(texts).toContain("#2 · Ada · 3 hours ago");
    expect(texts).toContain("#5 · Bo · 12 minutes ago");
    expect(texts).toContain("#7 · Ada · Just now");
  });
}
