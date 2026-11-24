import { describe, expect, it } from "vitest";
import { callFailed } from "../src/windows-api";

describe("a failed Windows call", () => {
  it("says which call failed, on what, and the code by name", () => {
    const error = callFailed("CreateServiceW", 1072, "io.eta.host");
    expect(error.message).toBe(
      "CreateServiceW(io.eta.host) failed: 1072 ERROR_SERVICE_MARKED_FOR_DELETE",
    );
    expect(error.code).toBe(1072);
    expect(error.call).toBe("CreateServiceW");
  });

  it("says when the call failed without a code", () => {
    expect(callFailed("OpenSCManagerW", 0).message).toBe(
      "OpenSCManagerW failed: 0 (the call failed without setting an error code)",
    );
  });
});
