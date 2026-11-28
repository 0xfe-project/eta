import { expect, test } from "nsh/test";
import { allowed, splitLines } from "../scripts/design-value-allowance";

const matchAt = (line: number) => ({
  range: { start: { line }, end: { line } },
});

test("allows line and block design-value comments with CRLF line endings", () => {
  const source = [
    'color: "#ffffff", // design-value: text over photo',
    "/* design-value: A4 in PDF points */",
    "const paperWidth = 595.28;",
    "{/* design-value: fixed dialog preview */}",
    "<View width={432} />",
  ].join("\r\n");
  const lines = splitLines(source);

  expect(allowed(matchAt(0), lines)).toEqual({ ok: true });
  expect(allowed(matchAt(2), lines)).toEqual({ ok: true });
  expect(allowed(matchAt(4), lines)).toEqual({ ok: true });
});

test("rejects CRLF design-value comments without a reason", () => {
  const source = [
    'color: "#ffffff", // design-value:',
    "/* design-value:   */",
    "const width = 432;",
    "const plain = 432;",
  ].join("\r\n");
  const lines = splitLines(source);

  expect(allowed(matchAt(0), lines)).toEqual({
    ok: false,
    reason: "`design-value:` needs a reason after it",
  });
  expect(allowed(matchAt(2), lines)).toEqual({
    ok: false,
    reason: "`design-value:` needs a reason after it",
  });
  expect(allowed(matchAt(3), lines)).toEqual({ ok: false });
});
