import { expect, open, test } from "nsh/test";
import { motion } from "../src/components/motion";

// A member's Inspect has two tabs: Trace (its run, where it opens) and Context (its session's
// system prompt block by block and its tools, the old web Inspect). The members of
// fixtures/member-inspect.tsx each stand for one state of the Context tab.

const fixture = "./fixtures/member-inspect.tsx";
const inspect = (nth: number) => `label:Inspect >> nth=${nth}`;
const tab = (name: string) => `id:inspect-tabs >> label:${name}`;

for (const [width, height] of [
  [1440, 900],
  [390, 844],
] as const) {
  const phone = width < 600;
  const openMember = async (
    app: Awaited<ReturnType<typeof open>>,
    nth: number,
    name: string,
  ) => {
    if (phone) {
      await app.press("label:Conversation info");
      await app.press(`text:${name} >> nth=1`);
    } else await app.press(inspect(nth));
  };

  test(`Inspect opens on Trace and switches to Context at ${width}px`, async () => {
    const app = await open(fixture, { width, height, locale: "en-US" });
    await openMember(app, 0, "Ada");
    expect(app.shows(tab("Trace"))).toBe(true);
    expect(app.texts()).toContain("The OG image is 1200×630.");
    expect(app.texts()).not.toContain("System prompt");

    await app.press(tab("Context"));
    expect(app.texts()).toContain("stable 30 / adaptive 12 · 2 blocks");
    expect(app.texts()).toContain("base");
    expect(app.texts()).toContain("stable · 30");
    expect(app.texts()).toContain("memory");
    expect(app.texts()).toContain("adaptive · 14");
    expect(app.texts()).toContain("2 tools");
    expect(app.texts()).toContain("esmrun");
    expect(app.texts()).toContain("· Run JavaScript in this session's realm.");
    expect(app.texts()).not.toContain("The OG image is 1200×630.");
    // Folded until asked.
    expect(app.texts()).not.toContain("You are Ada, a careful helper.");

    await app.press(tab("Trace"));
    expect(app.texts()).toContain("The OG image is 1200×630.");
  });

  test(`a prompt block and a tool open onto their whole text, which copies at ${width}px`, async () => {
    const app = await open(fixture, { width, height, locale: "en-US" });
    await openMember(app, 0, "Ada");
    await app.press(tab("Context"));

    await app.press("label:base");
    expect(app.texts()).toContain("You are Ada, a careful helper.");
    await app.press("label:Copy base");
    expect(app.clipboard()).toBe("You are Ada, a careful helper.");
    await app.press("label:base");
    expect(app.texts()).not.toContain("You are Ada, a careful helper.");

    await app.press("label:esmrun");
    expect(app.texts()).toContain(
      "Run JavaScript in this session's realm.\nThe last expression is the result.",
    );
  });
}

test("a member on another runtime says it has no breakdown instead of eta's side of it", async () => {
  const app = await open(fixture, {
    width: 1440,
    height: 900,
    locale: "en-US",
  });
  await app.press(inspect(1));
  await app.press(tab("Context"));
  expect(app.texts()).toContain(
    "Cody runs on Claude Code, which keeps its own system prompt and tools. eta cannot see what it sends, so there is no breakdown here.",
  );
  expect(app.texts()).not.toContain("base");
  expect(app.texts()).not.toContain("esmrun");
});

test("a session the host cannot open is an error", async () => {
  const app = await open(fixture, {
    width: 1440,
    height: 900,
    locale: "en-US",
  });
  await app.press(inspect(2));
  await app.press(tab("Context"));
  expect(app.texts()).toContain("Could not read this session's context.");
});

test("a session with no prompt yet says so, and is not an error", async () => {
  const app = await open(fixture, {
    width: 1440,
    height: 900,
    locale: "en-US",
  });
  await app.press(inspect(3));
  await app.press(tab("Context"));
  expect(app.texts()).toContain(
    "No prompt yet: it is composed once the member has a session.",
  );
  expect(app.texts()).toContain("No tools.");
  expect(app.texts()).not.toContain("Could not read this session's context.");
});

test("a view still on its way is being read", async () => {
  const app = await open(fixture, {
    width: 1440,
    height: 900,
    locale: "en-US",
  });
  await app.press(inspect(4));
  await app.press(tab("Context"));
  await app.wait(motion.reveal + 50);
  expect(app.shows("label:Reading the context…")).toBe(true);
  expect(app.texts()).not.toContain("Could not read this session's context.");
});
