import { expect, open, test } from "nsh/test";

// The animated face is not on any screen yet; this holds that it draws, runs, turns off and back
// on, and stands still under reduced motion, on a manual clock across several blink cycles.
const fixture = "./fixtures/agent-face-motion.tsx";
const seeds = [
  "2c9e55aa",
  "6e12ce64",
  "c3a676e3",
  "7dce50f0",
  "c236507e",
  "8270ccec",
];

for (const reducedMotion of [false, true])
  test(`${reducedMotion ? "with" : "without"} reduced motion, the faces draw, run and stop`, async () => {
    const app = await open(fixture, {
      width: 1024,
      height: 600,
      platform: "web",
      clock: {},
      reducedMotion,
    });
    await app.waitFor("text:Animating");
    for (const seed of seeds) {
      expect(app.count(`id:moving:${seed}`)).toBe(1);
      expect(app.count(`id:still:${seed}`)).toBe(1);
    }
    await app.clock!.runFor(8000);
    await app.press("label:Animate");
    await app.waitFor("text:Still");
    await app.clock!.runFor(1000);
    await app.press("label:Animate");
    await app.clock!.runFor(1000);
    expect(app.texts()).toContain("Animating");
  });
