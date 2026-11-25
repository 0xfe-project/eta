import { expect, open, test } from "nsh/test";

// A long picture name in a sent message stays inside the bubble, on a phone's width.
const fixture = "./fixtures/user-message-narrow.tsx";
const name = "screenshot_20261126_010037_dev.eta.client_very_long_name.png";
const network = {
  "GET http://example.invalid/attachments/a1": {
    headers: { "content-type": "image/png" },
    body: "png",
  },
};

test("a long picture name stays inside the bubble on a phone", async () => {
  const app = await open(fixture, {
    width: 390,
    height: 600,
    locale: "en-US",
    network,
  });
  await app.waitFor("label:Your message");
  const bubble = app.layout("label:Your message")!;
  const chip = app.layout(`label:View picture ${name} · 70 B`)!;
  expect(chip.x + chip.width).toBeLessThanOrEqual(bubble.x + bubble.width);
  expect(chip.x + chip.width).toBeLessThanOrEqual(390);
});

test("a long picture name beside short text keeps the bubble steady on a desktop", async () => {
  const app = await open("./fixtures/user-message-wide.tsx", {
    width: 900,
    height: 600,
    locale: "en-US",
    network,
  });
  const label = `label:View picture ${name} · 70 B`;
  await app.waitFor(label);
  const first = app.layout("label:Your message")!;
  const bubble = app.layout("label:Your message")!;
  const chip = app.layout(label)!;
  expect(chip.x + chip.width).toBeLessThanOrEqual(bubble.x + bubble.width);
  expect(bubble.width).toBe(first.width);
  expect(bubble.width).toBeGreaterThan(chip.width);
});
