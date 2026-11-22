import { describe, expect, it } from "vitest";
import {
  acpDraftOf,
  acpSlug,
  checkAcpDraft,
  parseAcpEnv,
} from "../src/acp-form";

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
    };
    expect(checkAcpDraft(acpDraftOf(config), [])).toEqual({
      ok: true,
      config,
    });
  });
  it("has no working directory or auto-allow: what an older file held is not carried", () => {
    const older = {
      id: "demo",
      label: "Demo",
      command: "demo",
      args: [],
      env: {},
      cwd: "/srv",
      autoAllow: true,
    };
    const draft = acpDraftOf(older);
    expect(Object.keys(draft).sort()).toEqual([
      "args",
      "command",
      "env",
      "id",
      "label",
    ]);
    expect(checkAcpDraft(draft, [])).toEqual({
      ok: true,
      config: { id: "demo", label: "Demo", command: "demo", args: [], env: {} },
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
