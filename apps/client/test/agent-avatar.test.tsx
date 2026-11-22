import { expect, open, test } from "nsh/test";

// The agent editor's avatar row: a draw passes over three faces and lands on a fourth, worn at once
// and saved; a failed save puts the old face back; the host keeps the last 8; taking a face back
// from the recent ones draws nothing new. The fixture draws `face0001`, `face0002`, ... in order.
const fixture = "./fixtures/agent-avatar.tsx";

async function editing(
  options: {
    seeds?: string[];
    save?: "ok" | "fail" | "hold";
    phone?: boolean;
    reducedMotion?: boolean;
  } = {},
) {
  const app = await open(fixture, {
    width: options.phone ? 390 : 1440,
    height: options.phone ? 844 : 900,
    locale: "en-US",
    platform: options.phone ? "ios" : "web",
    clock: {},
    reducedMotion: options.reducedMotion ?? false,
    storage: {
      seeds: (options.seeds ?? []).join(","),
      save: options.save ?? "ok",
      phone: options.phone ? "1" : "0",
    },
  });
  await app.waitFor("label:Draw another face");
  return app;
}

/** The face the large avatar shows. */
const shows = (app: App, seed: string) => app.count(`id:avatar:${seed}`) === 1;
type App = Awaited<ReturnType<typeof editing>>;
/** Where the recent face `seed` sits in the row, -1 when it is not there. */
function place(app: App, seed: string) {
  for (let at = 0; at < 9; at++)
    if (app.count(`id:recent:${at}:${seed}`) === 1) return at;
  return -1;
}
/** The recent faces among `candidates`, in the row's order. */
const recent = (app: App, candidates: string[]) =>
  candidates
    .filter((seed) => place(app, seed) >= 0)
    .sort((a, b) => place(app, a) - place(app, b));
/** Whether the recent face `seed` is the one marked worn. */
const marked = (app: App, seed: string) =>
  app.viewStyle(`id:recent:${place(app, seed)}:${seed}`)?.opacity === 1;
const sent = (app: App) => app.texts().find((text) => text.startsWith("Sent:"));
const drawn = (app: App) =>
  app.texts().find((text) => text.startsWith("Drawn:"));
const kept = (app: App) => app.texts().find((text) => text.startsWith("Kept:"));

for (const phone of [false, true])
  test(`${phone ? "phone" : "desktop"}: an agent that never drew one wears its id, the only recent face`, async () => {
    const app = await editing({ phone });
    expect(shows(app, "a1")).toBe(true);
    expect(recent(app, ["a1"])).toEqual(["a1"]);
    expect(marked(app, "a1")).toBe(true);
    expect(app.shows("label:Current face")).toBe(true);
  });

for (const phone of [false, true])
  test(`${phone ? "phone" : "desktop"}: a draw passes over three faces, then wears and saves the fourth, once`, async () => {
    const app = await editing({ phone });
    await app.press("label:Draw another face");
    // Three faces pass, 60ms apart, and the fourth lands 60ms after the last.
    expect(drawn(app)).toBe(
      "Drawn: face0001+0 face0002+60 face0003+120 face0004+180",
    );
    expect(sent(app)).toBe("Sent: agents.update face0004");
    expect(kept(app)).toBe("Kept: face0004 a1");
    expect(shows(app, "face0004")).toBe(true);
    expect(recent(app, ["face0004", "a1"])).toEqual(["face0004", "a1"]);
    expect(marked(app, "face0004")).toBe(true);
    expect(marked(app, "a1")).toBe(false);
  });

test("with reduced motion a draw lands at once, no faces passing", async () => {
  const app = await editing({ reducedMotion: true });
  await app.press("label:Draw another face");
  // The first face drawn is the one worn: none passes.
  expect(drawn(app)).toBe("Drawn: face0001+0");
  expect(shows(app, "face0001")).toBe(true);
  expect(sent(app)).toBe("Sent: agents.update face0001");
  expect(kept(app)).toBe("Kept: face0001 a1");
  expect(marked(app, "face0001")).toBe(true);
});

test("a save that fails puts the old face back and says so", async () => {
  const app = await editing({ seeds: ["s2", "s1", "a1"], save: "fail" });
  await app.press("label:Draw another face");
  expect(sent(app)).toBe("Sent: agents.update face0004");
  expect(shows(app, "s2")).toBe(true);
  expect(place(app, "face0004")).toBe(-1);
  expect(recent(app, ["s2", "s1", "a1"])).toEqual(["s2", "s1", "a1"]);
  expect(marked(app, "s2")).toBe(true);
  expect(kept(app)).toBe("Kept: s2 s1 a1");
  expect(app.texts()).toContain("The face was not saved: disk full");
});

test("the row keeps the last 8: a new face pushes the oldest out", async () => {
  const seeds = ["s8", "s7", "s6", "s5", "s4", "s3", "s2", "s1"];
  const app = await editing({ seeds, reducedMotion: true });
  expect(recent(app, seeds)).toHaveLength(8);
  await app.press("label:Draw another face");
  expect(recent(app, ["face0001", ...seeds])).toEqual([
    "face0001",
    ...seeds.slice(0, 7),
  ]);
  expect(kept(app)).toBe(`Kept: face0001 ${seeds.slice(0, 7).join(" ")}`);
});

test("while a face is being saved the row already wears it, and still shows 8", async () => {
  const seeds = ["s8", "s7", "s6", "s5", "s4", "s3", "s2", "s1"];
  const app = await editing({ seeds, save: "hold", reducedMotion: true });
  await app.press("label:Draw another face");
  expect(kept(app)).toBe(`Kept: ${seeds.join(" ")}`);
  expect(shows(app, "face0001")).toBe(true);
  expect(recent(app, ["face0001", ...seeds])).toEqual([
    "face0001",
    ...seeds.slice(0, 7),
  ]);
  expect(marked(app, "face0001")).toBe(true);
});

for (const phone of [false, true])
  test(`${phone ? "phone" : "desktop"}: pressing a recent face wears it again and draws nothing new`, async () => {
    const app = await editing({ seeds: ["s2", "s1", "a1"], phone });
    expect(marked(app, "s2")).toBe(true);
    await app.press("id:recent:1:s1");
    expect(shows(app, "s1")).toBe(true);
    expect(marked(app, "s1")).toBe(true);
    expect(marked(app, "s2")).toBe(false);
    expect(sent(app)).toBe("Sent: agents.update s1");
    expect(drawn(app)).toBe("Drawn: ");
    expect(kept(app)).toBe("Kept: s1 s2 a1");
    expect(recent(app, ["s1", "s2", "a1"])).toEqual(["s1", "s2", "a1"]);
    // Pressing the face worn changes nothing.
    await app.press("id:recent:0:s1");
    expect(sent(app)).toBe("Sent: agents.update s1");
  });
