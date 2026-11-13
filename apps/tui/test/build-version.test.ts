import { describe, expect, it } from "vitest";
import { buildVersion } from "../scripts/build-version";

describe("buildVersion", () => {
  it("takes ETA_TUI_VERSION first", () => {
    expect(
      buildVersion({ ETA_TUI_VERSION: "1.4.0", ETA_DAEMON_VERSION: "1.3.0" }),
    ).toBe("1.4.0");
  });

  it("takes ETA_DAEMON_VERSION, which the release workflow sets, when ETA_TUI_VERSION is unset or blank", () => {
    expect(buildVersion({ ETA_DAEMON_VERSION: "1.3.0" })).toBe("1.3.0");
    expect(
      buildVersion({ ETA_TUI_VERSION: "  ", ETA_DAEMON_VERSION: " 1.3.0 " }),
    ).toBe("1.3.0");
  });

  it("is dev when neither is set to anything", () => {
    expect(buildVersion({})).toBe("dev");
    expect(buildVersion({ ETA_TUI_VERSION: "", ETA_DAEMON_VERSION: " " })).toBe(
      "dev",
    );
  });
});
