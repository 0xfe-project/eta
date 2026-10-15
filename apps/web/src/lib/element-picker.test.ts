import { beforeEach, expect, it } from "@rstest/core";
import { storageKey } from "@/components/workspace/workspace-store";
import { elementPickerDefault, savedElementPicker } from "./element-picker";

beforeEach(() => {
  localStorage.clear();
});

it("follows the build until a choice is saved", () => {
  expect(savedElementPicker()).toBe(elementPickerDefault());
  localStorage.setItem(storageKey, JSON.stringify({ lastModel: "m1" }));
  expect(savedElementPicker()).toBe(elementPickerDefault());
});

it("reads the saved choice from the workspace object", () => {
  localStorage.setItem(storageKey, JSON.stringify({ reactGrab: true }));
  expect(savedElementPicker()).toBe(true);
  localStorage.setItem(storageKey, JSON.stringify({ reactGrab: false }));
  expect(savedElementPicker()).toBe(false);
});

it("ignores what it cannot read", () => {
  localStorage.setItem(storageKey, "{");
  expect(savedElementPicker()).toBe(elementPickerDefault());
  localStorage.setItem(storageKey, JSON.stringify({ reactGrab: "yes" }));
  expect(savedElementPicker()).toBe(elementPickerDefault());
});
