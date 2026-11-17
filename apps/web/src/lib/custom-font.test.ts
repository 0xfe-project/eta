import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { useWorkspaceStore } from "@/components/workspace/workspace-store";
import {
  applyCustomFont,
  customFontStack,
  defaultFontStack,
  normalizeCustomFont,
  watchCustomFont,
} from "./custom-font";

const root = () => document.documentElement;
const sans = () => root().style.getPropertyValue("--font-sans");
const mono = () => root().style.getPropertyValue("--font-mono");

beforeEach(() => {
  localStorage.clear();
  useWorkspaceStore.setState({ workspace: {} });
  applyCustomFont({});
});

describe("normalizeCustomFont", () => {
  it.each([
    ["Inter", "Inter"],
    ["  JetBrains   Mono  ", "JetBrains Mono"],
    ["Source Han Sans SC", "Source Han Sans SC"],
    ["思源黑体", "思源黑体"],
    ["LXGW WenKai GB.Screen", "LXGW WenKai GB.Screen"],
    ["SF-Pro_Text", "SF-Pro_Text"],
    ["", ""],
    ["   ", ""],
  ])("accepts %j as %j", (input, name) => {
    expect(normalizeCustomFont(input)).toBe(name);
  });

  it.each([
    "Inter; color: red",
    "Inter}body{display:none",
    'Inter", serif',
    "Inter'",
    "Inter, serif",
    "url(https://evil.example/x.woff2)",
    "Inter) url(x",
    "var(--x)",
    "Inter\\22",
    "a/*b*/",
    "<script>",
    "Inter:hover",
    "-leading-dash",
    "x".repeat(65),
  ])("refuses %j", (input) => {
    expect(normalizeCustomFont(input)).toBeNull();
  });
});

describe("applyCustomFont", () => {
  it("puts the interface font in front of the shipped stack, for sans and mono", () => {
    applyCustomFont({ sans: "Inter" });
    expect(customFontStack("Inter")).toBe(`"Inter", ${defaultFontStack}`);
    expect(sans()).toBe(customFontStack("Inter"));
    expect(mono()).toBe(customFontStack("Inter"));
    expect(root().dataset.customFont).toBe("Inter");
  });

  it("empty or unset goes back to the stylesheet's default", () => {
    applyCustomFont({ sans: "Inter" });
    applyCustomFont({ sans: "" });
    expect(sans()).toBe("");
    expect(mono()).toBe("");
    expect(root().dataset.customFont).toBeUndefined();
    applyCustomFont({ sans: "Inter" });
    applyCustomFont({});
    expect(sans()).toBe("");
  });

  it("a stored value that fails the check is not applied", () => {
    applyCustomFont({ sans: "Inter" });
    applyCustomFont({ sans: 'x"; background: url(evil)' });
    expect(sans()).toBe("");
    expect(root().dataset.customFont).toBeUndefined();
    expect(root().getAttribute("style") ?? "").not.toContain("url(");
  });

  it("a mono font changes only --font-mono, in front of the interface font", () => {
    applyCustomFont({ mono: "JetBrains Mono" });
    expect(sans()).toBe("");
    expect(mono()).toBe(`"JetBrains Mono", ${defaultFontStack}`);
    expect(root().dataset.customMonoFont).toBe("JetBrains Mono");
    expect(root().dataset.customFont).toBeUndefined();

    applyCustomFont({ sans: "Inter", mono: "JetBrains Mono" });
    expect(sans()).toBe(customFontStack("Inter"));
    expect(mono()).toBe(`"JetBrains Mono", "Inter", ${defaultFontStack}`);

    // Mono cleared: it follows the interface font again.
    applyCustomFont({ sans: "Inter", mono: "" });
    expect(mono()).toBe(customFontStack("Inter"));
    expect(root().dataset.customMonoFont).toBeUndefined();
  });

  it("a mono value that fails the check is not applied either", () => {
    applyCustomFont({ mono: "Mono; } * { font: 0/0 url(x)" });
    expect(mono()).toBe("");
    expect(root().getAttribute("style") ?? "").not.toContain("url(");
    applyCustomFont({ sans: "Inter", mono: "a,b" });
    expect(mono()).toBe(customFontStack("Inter"));
  });

  it("falls back to Eta Sans before the system faces", () => {
    expect(defaultFontStack.startsWith('"Eta Sans", ')).toBe(true);
    // The stack here is the one styles.css declares, so a fallback is never a different product.
    const styles = readFileSync(
      new URL("../styles.css", import.meta.url),
      "utf8",
    ).replace(/\s+/g, " ");
    expect(styles).toContain(`--font-sans: ${defaultFontStack};`);
    expect(styles).toContain(`--font-mono: ${defaultFontStack};`);
    // Out of `@theme inline`, or the override on <html> would reach nothing.
    expect(styles).toMatch(/@theme \{ --font-sans:/);
  });
});

describe("watchCustomFont", () => {
  let stop: (() => void) | undefined;
  afterEach(() => stop?.());

  it("follows the setting and survives a reload", async () => {
    stop = watchCustomFont();
    expect(sans()).toBe("");

    useWorkspaceStore.getState().setWorkspace({ customFont: "Inter" });
    expect(sans()).toBe(customFontStack("Inter"));
    expect(
      JSON.parse(localStorage.getItem("eta.workspace.v1") ?? "{}"),
    ).toMatchObject({ customFont: "Inter" });

    // A reload: the document starts bare and the store from what was saved.
    stop();
    const saved = localStorage.getItem("eta.workspace.v1")!;
    applyCustomFont({});
    useWorkspaceStore.setState({ workspace: {} });
    localStorage.setItem("eta.workspace.v1", saved);
    await useWorkspaceStore.persist.rehydrate();
    stop = watchCustomFont();
    expect(useWorkspaceStore.getState().workspace.customFont).toBe("Inter");
    expect(sans()).toBe(customFontStack("Inter"));

    useWorkspaceStore.getState().setWorkspace({});
    expect(sans()).toBe("");
  });

  it("follows the mono setting on its own and survives a reload", async () => {
    stop = watchCustomFont();
    useWorkspaceStore
      .getState()
      .setWorkspace({ customFont: "Inter", customMonoFont: "Fira Code" });
    expect(mono()).toBe(`"Fira Code", "Inter", ${defaultFontStack}`);

    stop();
    const saved = localStorage.getItem("eta.workspace.v1")!;
    applyCustomFont({});
    useWorkspaceStore.setState({ workspace: {} });
    localStorage.setItem("eta.workspace.v1", saved);
    await useWorkspaceStore.persist.rehydrate();
    stop = watchCustomFont();
    expect(useWorkspaceStore.getState().workspace.customMonoFont).toBe(
      "Fira Code",
    );
    expect(mono()).toBe(`"Fira Code", "Inter", ${defaultFontStack}`);

    useWorkspaceStore.getState().setWorkspace({ customMonoFont: "Fira Code" });
    expect(sans()).toBe("");
    expect(mono()).toBe(`"Fira Code", ${defaultFontStack}`);
  });
});
