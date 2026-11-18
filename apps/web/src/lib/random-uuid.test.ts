import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "./random-uuid";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("randomUUID", () => {
  const originalCrypto = globalThis.crypto;
  const originalDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "crypto",
  );

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalDescriptor) {
      Object.defineProperty(globalThis, "crypto", originalDescriptor);
    } else {
      Object.defineProperty(globalThis, "crypto", {
        configurable: true,
        value: originalCrypto,
      });
    }
  });

  it("uses native crypto.randomUUID when available", () => {
    const spy = vi
      .spyOn(globalThis.crypto, "randomUUID")
      .mockReturnValue("11111111-1111-4111-8111-111111111111");
    expect(randomUUID()).toBe("11111111-1111-4111-8111-111111111111");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("falls back to crypto.getRandomValues when randomUUID is missing", () => {
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: {
        getRandomValues: <T extends ArrayBufferView<ArrayBuffer>>(arr: T): T =>
          originalCrypto.getRandomValues(arr),
      },
    });
    const a = randomUUID();
    const b = randomUUID();
    expect(a).toMatch(UUID_V4);
    expect(b).toMatch(UUID_V4);
    expect(a).not.toBe(b);
  });

  it("falls back to Math.random when crypto is unavailable", () => {
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: undefined,
    });
    const a = randomUUID();
    const b = randomUUID();
    expect(a).toMatch(UUID_V4);
    expect(b).toMatch(UUID_V4);
    expect(a).not.toBe(b);
  });
});
