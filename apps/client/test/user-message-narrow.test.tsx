import { expect, open, test } from "nsh/test";

// A long file name in a sent message stays inside the bubble, whatever the width.
const png = "screenshot_20261126_010037_dev.eta.client_very_long_name.png";
const pdf = "screenshot_20261126_010037_dev.eta.client_very_long_name.pdf";
const network = {
  "GET http://example.invalid/attachments/a1": {
    headers: { "content-type": "image/png" },
    body: "png",
  },
};

async function inside(fixture: string, width: number, label: string) {
  const app = await open(fixture, {
    width,
    height: 600,
    locale: "en-US",
    network,
  });
  await app.waitFor(label);
  await app.wait(300);
  const bubble = app.layout("label:Your message")!;
  const chip = app.layout(label)!;
  expect(chip.width).toBeGreaterThan(0);
  expect(chip.x + chip.width).toBeLessThanOrEqual(bubble.x + bubble.width);
  expect(chip.x + chip.width).toBeLessThanOrEqual(width);
  return { app, bubble };
}

test("a long picture name stays inside the bubble on a phone", async () => {
  await inside(
    "./fixtures/user-message-narrow.tsx",
    390,
    `label:View picture ${png} · 70 B`,
  );
});

test("a long picture name stays inside the bubble in a narrow desktop column", async () => {
  await inside(
    "./fixtures/user-message-tablet.tsx",
    360,
    `label:View picture ${png} · 70 B`,
  );
});

test("a long file name stays inside the bubble on a phone", async () => {
  await inside("./fixtures/user-message-pdf.tsx", 390, `text:${pdf}`);
});

test("a long picture name beside short text keeps the bubble steady on a desktop", async () => {
  const label = `label:View picture ${png} · 70 B`;
  const { app, bubble } = await inside(
    "./fixtures/user-message-wide.tsx",
    900,
    label,
  );
  await app.wait(300);
  expect(app.layout("label:Your message")!.width).toBe(bubble.width);
  expect(bubble.width).toBeGreaterThan(app.layout(label)!.width);
});
