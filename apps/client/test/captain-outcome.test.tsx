import { expect, open, test } from "nsh/test";

const fixture = "./fixtures/captain-outcome.tsx";

test("skips captainOutcome rows in the timeline", async () => {
  const app = await open(fixture, {
    width: 1440,
    height: 1400,
    locale: "en-US",
  });
  expect(app.texts().some((t) => t.includes("Your proposed group"))).toBe(
    false,
  );
  expect(app.texts().some((t) => t.includes("68d72847"))).toBe(false);
  expect(app.texts().some((t) => t.includes("legacy-group"))).toBe(false);

  await app.press("label:Only outcome");
  expect(app.shows("text:No conversation with Captain yet")).toBe(true);
  expect(app.shows("text:Copy")).toBe(false);
  expect(app.texts().some((t) => t.includes("Your proposed group"))).toBe(
    false,
  );
});

test("still renders captainReview system rows", async () => {
  const app = await open(fixture, {
    width: 1440,
    height: 1400,
    locale: "en-US",
  });
  expect(app.shows("text:Captain review")).toBe(true);
  expect(app.shows("text:Release notes are ready for review.")).toBe(true);
  expect(app.shows("text:Task #7")).toBe(true);
});

test("proposal cards show applied, rejected, and failed outcomes with operation.error", async () => {
  const app = await open(fixture, {
    width: 1440,
    height: 1400,
    locale: "en-US",
  });
  expect(app.shows("text:nsh-awesome")).toBe(true);
  expect(app.shows("text:■ Created")).toBe(true);
  expect(app.shows("text:old-group")).toBe(true);
  expect(app.shows("text:■ Rejected")).toBe(true);
  expect(app.shows("text:broken-group")).toBe(true);
  expect(app.shows("text:■ Failed")).toBe(true);
  expect(app.shows("text:ENOENT: /home/akrc/missing does not exist")).toBe(
    true,
  );

  await app.press("label:nsh-awesome");
  expect(app.texts()).toContain("/home/akrc/Developer/nsh-awesome");
  expect(app.shows("text:Create")).toBe(false);
  expect(app.shows("text:Reject")).toBe(false);
});
