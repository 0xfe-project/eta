import { expect, open, test } from "nsh/test";

test("with no catalog address the market says so and offers to set one", async () => {
  const app = await open("./fixtures/market.tsx", { width: 900, height: 700 });
  expect(app.shows("No catalog address is set")).toBe(true);
  expect(app.shows("Set catalog address")).toBe(true);
});
