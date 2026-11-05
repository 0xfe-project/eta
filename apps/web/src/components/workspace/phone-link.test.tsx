import { describe, expect, it } from "@rstest/core";
import { isLoopback } from "./phone-address";

describe("isLoopback", () => {
  it("knows the names a phone cannot dial", () => {
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("localhost")).toBe(true);
    expect(isLoopback("[::1]")).toBe(true);
    expect(isLoopback("mac-studio.tail3f2a.ts.net")).toBe(false);
    expect(isLoopback("192.168.1.8")).toBe(false);
  });
});
