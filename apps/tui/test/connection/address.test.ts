import { describe, expect, it } from "vitest";
import { normalizeAddress, wireUrl } from "../../src/connection/address";

describe("normalizeAddress", () => {
  it("keeps an http or https base as it is", () => {
    expect(normalizeAddress("http://127.0.0.1:8787")).toBe(
      "http://127.0.0.1:8787",
    );
    expect(normalizeAddress("https://eta.example.com")).toBe(
      "https://eta.example.com",
    );
  });

  it("trims and takes an address without a scheme as http", () => {
    expect(normalizeAddress("  localhost:8787 \n")).toBe(
      "http://localhost:8787",
    );
    expect(normalizeAddress("box.tailnet.ts.net")).toBe(
      "http://box.tailnet.ts.net",
    );
  });

  it("takes ws as http and wss as https", () => {
    expect(normalizeAddress("ws://h:1/ws")).toBe("http://h:1");
    expect(normalizeAddress("wss://h/ws")).toBe("https://h");
    expect(normalizeAddress("WSS://H:2")).toBe("https://h:2");
  });

  it("drops the path, query, fragment and trailing slash", () => {
    expect(normalizeAddress("http://h:1/")).toBe("http://h:1");
    expect(normalizeAddress("https://h:1/a/b/?q=1#frag")).toBe("https://h:1");
    expect(normalizeAddress("h:3/ws")).toBe("http://h:3");
  });

  it("keeps an IPv6 host", () => {
    expect(normalizeAddress("http://[::1]:8787/")).toBe("http://[::1]:8787");
  });

  it("refuses other schemes, and addresses without a host", () => {
    for (const text of [
      "",
      "   ",
      "ftp://h",
      "file:///etc/passwd",
      "http://",
      "https:///path",
      "ws://",
      "http://h:99999",
      "mailto:me@example.com",
    ]) {
      expect(normalizeAddress(text), JSON.stringify(text)).toBeUndefined();
    }
  });
});

describe("wireUrl", () => {
  it("is the base with a ws scheme and /ws", () => {
    expect(wireUrl("http://127.0.0.1:8787")).toBe("ws://127.0.0.1:8787/ws");
    expect(wireUrl("https://eta.example.com")).toBe("wss://eta.example.com/ws");
  });
});
