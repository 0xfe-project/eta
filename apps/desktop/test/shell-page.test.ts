import { describe, expect, it } from "vitest";
import { WORDS } from "../src/bun/shell-page";

const REASONS = [
  "address",
  "unreachable",
  "timeout",
  "not-eta",
  "token",
  "no-page",
  "lost",
  "host",
  // A download's failures: every `DownloadFailure` kind, and a refusal without a token.
  "download-offline",
  "download-interrupted",
  "download-checksum",
  "download-refused",
  "download-token",
  "download-none",
  "download-broken",
  "download-disk",
];

describe("the shell's words", () => {
  it.each(["zh", "en"] as const)(
    "say something for every failure in %s",
    (language) => {
      for (const reason of REASONS) {
        expect(WORDS[language]).toHaveProperty([`failure.${reason}.title`]);
        expect(WORDS[language]).toHaveProperty([`failure.${reason}.body`]);
      }
    },
  );
});
