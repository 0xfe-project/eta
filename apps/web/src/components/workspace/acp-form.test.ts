import { describe, expect, it } from "@rstest/core";
import { acpDraftOf, acpSlug, checkAcpDraft, parseAcpEnv } from "./acp-form";

describe("parseAcpEnv", () => {
  it("reads KEY=VALUE lines, keeping = in values, skipping blanks and comments", () => {
    expect(parseAcpEnv("A=1\n\n# note\n B = x=y \nEMPTY=")).toEqual({
      ok: true,
      env: { A: "1", B: " x=y", EMPTY: "" },
    });
  });
  it("names the first bad line", () => {
    expect(parseAcpEnv("A=1\nnope")).toEqual({
      ok: false,
      line: 2,
      reason: "noEquals",
    });
    expect(parseAcpEnv(" =1")).toEqual({
      ok: false,
      line: 1,
      reason: "emptyKey",
    });
    expect(parseAcpEnv("A=1\nA=2")).toEqual({
      ok: false,
      line: 2,
      reason: "duplicate",
    });
  });
});

describe("acpSlug", () => {
  it("turns a name into an id", () => {
    expect(acpSlug("  My Agent (beta) ")).toBe("my-agent-beta");
    expect(acpSlug("Café 2")).toBe("cafe-2");
    // Nothing usable is left: the id is typed by hand.
    expect(acpSlug("我的助手")).toBe("");
  });
});

describe("checkAcpDraft", () => {
  it("round-trips a stored config", () => {
    const config = {
      id: "demo",
      label: "Demo",
      command: "demo",
      args: ["--acp", "-v"],
      env: { A: "1" },
      cwd: "/srv",
      autoAllow: true,
    };
    expect(checkAcpDraft(acpDraftOf(config), [])).toEqual({
      ok: true,
      config,
    });
  });
  it("refuses an id taken by another agent", () => {
    const draft = acpDraftOf({
      id: "demo",
      label: "Demo",
      command: "demo",
      args: [],
      env: {},
    });
    expect(checkAcpDraft(draft, ["demo"])).toEqual({
      ok: false,
      problems: { id: { key: "errors.idTaken" } },
    });
  });
});
