import { expect, open, test } from "nsh/test";

test("an esmrun step shows the start of its script", async () => {
  const app = await open("./fixtures/process-step.tsx", {
    width: 800,
    height: 400,
  });
  expect(app.shows("esmrun · const files = await eta.fs.list('src');")).toBe(
    true,
  );
});

test("an esmrun step with one view effect shows the viewed path", async () => {
  const app = await open("./fixtures/process-step.tsx", {
    width: 800,
    height: 400,
  });
  expect(app.shows("view · src/foo.ts")).toBe(true);
});

test("a Bash step shows its command", async () => {
  const app = await open("./fixtures/process-step.tsx", {
    width: 800,
    height: 400,
  });
  expect(app.shows("Bash · ls -la")).toBe(true);
});
