import { describe, expect, it } from "@rstest/core";
import { compactionNotice } from "./compaction-notice";

describe("what a /compact on an external runtime tells the user", () => {
  it("only calls a completed compaction a success", () => {
    const runtime = "Claude Code";
    const levelOf = (
      outcome: Parameters<typeof compactionNotice>[0]["outcome"],
    ) => compactionNotice({ runtime, outcome }).level;
    expect(levelOf("completed")).toBe("success");
    for (const outcome of [
      "empty",
      "busy",
      "unsupported",
      "aborted",
      "failed",
      "unconfirmed",
    ] as const)
      expect(levelOf(outcome)).not.toBe("success");
  });

  it("names the runtime and gives its reason", () => {
    const { text, level } = compactionNotice({
      runtime: "Codex",
      outcome: "failed",
      reason: "the turn failed",
    });
    expect(level).toBe("error");
    expect(text).toContain("Codex");
    expect(text).toContain("the turn failed");
    expect(
      compactionNotice({ runtime: "OpenCode", outcome: "unsupported" }).text,
    ).toContain("OpenCode");
  });
});
