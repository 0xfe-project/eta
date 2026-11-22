import { expect, open, test } from "nsh/test";

test("with no catalog address the market says so and offers to set one", async () => {
  const app = await open("./fixtures/market.tsx", { width: 900, height: 700 });
  expect(app.shows("No catalog address is set")).toBe(true);
  expect(app.shows("Set catalog address")).toBe(true);
});

test("a card shows no separator when the entry has no author", async () => {
  const app = await open("./fixtures/market-authors.tsx", { width: 900, height: 700 });
  expect(app.shows("1.0.0 · t")).toBe(true);
  expect(app.shows("2.0.0")).toBe(true);
  expect(app.shows("3.0.0")).toBe(true);
  expect(app.shows("2.0.0 ·")).toBe(false);
  expect(app.shows("3.0.0 ·")).toBe(false);
});
