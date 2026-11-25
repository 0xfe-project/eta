import type { BackState } from "../src/app/back";
import { expect, test } from "nsh/test";
import { backAction } from "../src/app/back";

/** Everything closed but the chat list on a phone: the starting point each case changes. */
const quiet: BackState = {
  overlay: "absent",
  settings: undefined,
  task: false,
  phone: true,
  page: "chat",
  conversation: false,
  onboarding: false,
};

test("back closes a dismissable overlay before anything under it", () => {
  expect(backAction({ ...quiet, overlay: "dismissable" })).toEqual({
    kind: "dismiss-overlay",
  });
});

test("a dismissable overlay closes before the Settings under it", () => {
  expect(
    backAction({ ...quiet, overlay: "dismissable", settings: "Agents" }),
  ).toEqual({ kind: "dismiss-overlay" });
});

test("back goes to Settings before the task and the conversation under it", () => {
  expect(
    backAction({
      ...quiet,
      settings: "Agents",
      task: true,
      conversation: true,
    }),
  ).toEqual({ kind: "close-settings", section: "Agents" });
});

test("back closes a task pushed over its page, but not the tasks page itself", () => {
  expect(backAction({ ...quiet, task: true, conversation: true })).toEqual({
    kind: "close-task",
  });
});

test("back takes the phone conversation off the chat list", () => {
  expect(backAction({ ...quiet, conversation: true })).toEqual({
    kind: "back-to-list",
  });
});

test("a phone conversation closes before onboarding under it", () => {
  expect(
    backAction({ ...quiet, conversation: true, onboarding: true }),
  ).toEqual({
    kind: "back-to-list",
  });
});

test("back leaves onboarding before it leaves the app", () => {
  expect(backAction({ ...quiet, onboarding: true })).toEqual({
    kind: "leave-onboarding",
  });
});

test("back with nothing open leaves the app", () => {
  expect(backAction(quiet)).toEqual({ kind: "exit-app" });
});

test("a phone conversation is one layer: on a desktop it is not a layer at all", () => {
  expect(backAction({ ...quiet, phone: false, conversation: true })).toEqual({
    kind: "exit-app",
  });
});

test("an overlay that refuses to close does not swallow the press", () => {
  expect(
    backAction({ ...quiet, overlay: "blocked", settings: "Appearance" }),
  ).toEqual({ kind: "close-settings", section: "Appearance" });
  expect(backAction({ ...quiet, overlay: "blocked" })).toEqual({
    kind: "exit-app",
  });
});
