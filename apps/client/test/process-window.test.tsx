import { expect, open, test } from "nsh/test";
import { palette } from "../src/components/theme";

const fixture = "./fixtures/process-window.tsx";
const canvas = `${palette("light").canvas.toLowerCase()}ff`;

// The headless engine lays a sticky view out in its place and never moves it with the scroll, so
// the pinning itself (the native `position: sticky` in the scroll view around the step) is checked
// in a browser. Here: an open step's title is the one with an opaque fill, which is what the
// scrolled content passes under, and a folded step's is not.
for (const width of [1440, 390]) {
  test(`an open thought's title takes an opaque fill to hold the top of the process window (${width}px)`, async () => {
    const app = await open(fixture, {
      width,
      height: 900,
      colorScheme: "light",
    });
    expect(app.viewStyle("label:Thinking")?.backgroundColor ?? null).toBeNull();
    await app.press("label:Thinking");
    expect(app.viewStyle("label:Thinking")?.backgroundColor).toBe(canvas);
    await app.press("label:Thinking");
    expect(app.viewStyle("label:Thinking")?.backgroundColor ?? null).toBeNull();
  });

  test(`folding a call scrolled past leaves the window on its row (${width}px)`, async () => {
    const app = await open(fixture, { width, height: 900 });
    const frame = app.layout("id:window")!;
    const title = "text:bash · seq 40";
    await app.press(title);
    await app.scroll("id:window", -300);
    await app.press(title);
    expect(app.shows("text:line 20")).toBe(false);
    const folded = app.layout(title)!;
    expect(folded.y).toBeGreaterThanOrEqual(frame.y);
    expect(folded.y).toBeLessThan(frame.y + 32);
  });

  test(`folding a thought scrolled past leaves the window on its row (${width}px)`, async () => {
    const app = await open(fixture, { width, height: 900 });
    const frame = app.layout("id:window")!;
    await app.press("label:Thinking");
    await app.scroll("id:window", -300);
    await app.press("label:Thinking");
    expect(app.shows("text:line 20")).toBe(false);
    expect(app.layout("label:Thinking")!.y).toBe(frame.y);
  });
}
