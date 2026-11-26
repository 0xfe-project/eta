import type { AccessibilityNode } from "nsh/test";
import { expect, open, test } from "nsh/test";

function hasRole(node: AccessibilityNode | null, role: string): boolean {
  if (!node) return false;
  if (node.role === role) return true;
  return node.children.some((child) => hasRole(child, role));
}

test("EntityRow button fills the full row width and height up to the bottom rule, keeping menu presses separate", async () => {
  const app = await open("./fixtures/entity-row.tsx", {
    width: 600,
    height: 500,
    platform: "macos",
    locale: "en-US",
  });
  await app.waitFor("text:Alice");

  // Full-row pressable target for a row with a menu.
  const menuRow = app.layout("id:row-with-menu")!;
  const rowButton = app.layout("label:Alice >> nth=0")!;
  const menuTrigger = app.layout("label:Alice >> nth=1")!;
  expect(rowButton.x).toBe(menuRow.x);
  expect(rowButton.y).toBe(menuRow.y);
  expect(rowButton.width).toBe(menuRow.width);
  expect(rowButton.height).toBe(menuRow.height - 1);
  // The menu sits on the reserved right padding, 16px from the right edge and 8px from the top.
  expect(menuTrigger.x + menuTrigger.width).toBe(
    menuRow.x + menuRow.width - 16,
  );
  expect(menuTrigger.y).toBe(menuRow.y + 8);
  expect(menuTrigger.width).toBe(24);
  expect(menuTrigger.height).toBe(24);

  // Full-row pressable target for caret and phone stacked layouts.
  const caretRow = app.layout("id:row-with-caret")!;
  const caretButton = app.layout("label:Source")!;
  expect(caretButton.x).toBe(caretRow.x);
  expect(caretButton.width).toBe(caretRow.width);
  expect(caretButton.height).toBe(caretRow.height - 1);

  const stackedRow = app.layout("id:row-stacked")!;
  const stackedButton = app.layout("label:Phone agent")!;
  expect(stackedButton.x).toBe(stackedRow.x);
  expect(stackedButton.width).toBe(stackedRow.width);
  expect(stackedButton.height).toBe(stackedRow.height - 1);
  // Stacked hides the menu so only the row carries the label.
  expect(app.count("label:Phone agent")).toBe(1);

  // Pressing the row fires only the row's action, never the menu.
  await app.press("label:Alice >> nth=0");
  expect(app.shows("label:Edit")).toBe(false);
  expect(
    app.shows("text:row:1 menu:0 caret:0 stacked:0 restore:0 ref:true"),
  ).toBe(true);

  // Pressing the menu opens only the menu, never the row.
  await app.press("label:Alice >> nth=1");
  await app.waitFor("label:Edit");
  expect(
    app.shows("text:row:1 menu:0 caret:0 stacked:0 restore:0 ref:true"),
  ).toBe(true);
  await app.press("label:Edit");
  await app.waitUntil(() => !app.shows("label:Edit"));
  expect(
    app.shows("text:row:1 menu:1 caret:0 stacked:0 restore:0 ref:true"),
  ).toBe(true);

  // Caret and stacked rows remain pressable.
  await app.press("label:Source");
  await app.press("label:Phone agent");
  expect(
    app.shows("text:row:1 menu:1 caret:1 stacked:1 restore:0 ref:true"),
  ).toBe(true);

  // A caret row without onPress is not a button.
  expect(hasRole(app.accessibility("id:row-static-caret"), "button")).toBe(
    false,
  );

  // A menu-only row without onPress keeps the row non-pressable while its menu still works.
  expect(app.count("label:Archived chat")).toBe(1);
  await app.press("label:Archived chat");
  await app.waitFor("label:Restore");
  await app.press("label:Restore");
  expect(
    app.shows("text:row:1 menu:1 caret:1 stacked:1 restore:1 ref:true"),
  ).toBe(true);
});
