import { readFileSync } from "node:fs";
import { describe, expect, it } from "@rstest/core";

// index.html's boot outline: what shows before any script runs. It is static HTML, so the only way
// to keep it honest is to read the file.
const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const page = new DOMParser().parseFromString(html, "text/html");
const style = [...page.querySelectorAll("style")]
  .map((node) => node.textContent ?? "")
  .join("\n");

describe("脚本运行前的启动轮廓", () => {
  it("sits in #root, hidden from assistive tech, with no words to translate", () => {
    const boot = page.querySelector("#root > .boot");
    expect(boot).not.toBeNull();
    expect(boot?.getAttribute("aria-hidden")).toBe("true");
    expect(boot?.textContent?.trim()).toBe("");
  });

  it("sweeps only for readers who allow motion, and has a dark mode", () => {
    const motion = style.indexOf("prefers-reduced-motion: no-preference");
    expect(motion).toBeGreaterThan(-1);
    expect(style.slice(motion)).toMatch(/animation:\s*boot-sweep/);
    // The only boot-sweep animation is the one inside that query.
    expect(style.match(/animation:\s*boot-sweep/g)).toHaveLength(1);
    expect(style).toContain("html.dark .boot");
  });

  it("opens at the dragged sidebar width, on both sides of lg", () => {
    expect(style).toContain("width: var(--boot-side, 16rem)");
    expect(style).toContain("width: var(--boot-side, 18rem)");
    expect(html).toContain('localStorage.getItem("eta.sidebar.width")');
  });
});
