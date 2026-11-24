import { expect, test } from "nsh/test";
import {
  avatarFill,
  avatarInitial,
  avatarInk,
} from "../src/pages/plugins/avatar-color";

test("the fill comes from the first letter, in any case", () => {
  expect(avatarFill("firecrawl")).toBe(avatarFill("figma"));
  expect(avatarFill("Neon")).toBe(avatarFill("neon"));
  expect(avatarFill("  neon")).toBe(avatarFill("neon"));
});
test("different letters can differ", () => {
  const fills = new Set("abcdefghij".split("").map((c) => avatarFill(c)));
  expect(fills.size).toBeGreaterThan(1);
});
test("a CJK first character works and an empty name does not crash", () => {
  expect(avatarInitial("插件")).toBe("插");
  expect(avatarFill("插件")).toBe(avatarFill("插"));
  expect(avatarInitial("")).toBe("?");
  expect(typeof avatarFill("")).toBe("string");
});
test("the text colour is chosen by contrast", () => {
  expect(avatarInk("#FFFFFF")).toBe("#000000");
  expect(avatarInk("#5B6EAE")).toBe("#FFFFFF");
});
