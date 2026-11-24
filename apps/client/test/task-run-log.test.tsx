import { expect, open, test } from "nsh/test";

for (const [width, height] of [
  [1440, 900],
  [1024, 768],
  [390, 844],
] as const)
  test(`a task's "View process" still opens its run in the run panel (${width}px)`, async () => {
    const app = await open("./fixtures/task-run-log.tsx", { width, height });
    await app.press("View process");
    expect(app.shows("role:dialog")).toBe(true);
    // The run's timing strip, then every step and what it said.
    expect(app.shows("label:Generation")).toBe(true);
    expect(app.shows("label:Read / search")).toBe(true);
    expect(app.shows("Looking for the footer first.")).toBe(true);
    expect(app.shows("The links point at /old.")).toBe(true);
    expect(app.texts().some((text) => text.includes("src/footer.tsx"))).toBe(
      true,
    );
    await app.press(width < 600 ? "label:Back" : "label:Close");
    // The panel goes out before it is gone.
    await app.waitUntil(() => !app.shows("role:dialog"));
  });
