import { expect, test } from "nsh/test";
import {
  clampPaneWidth,
  draggedPaneWidth,
  paneLimits,
  parsePaneWidth,
} from "../src/app/pane-width";

test("a width is rounded and held to the pane's range", () => {
  expect(clampPaneWidth("sidebar", 100)).toBe(260);
  expect(clampPaneWidth("sidebar", 9999)).toBe(420);
  expect(clampPaneWidth("sidebar", 300.6)).toBe(301);
  expect(clampPaneWidth("panel", 100)).toBe(320);
  expect(clampPaneWidth("panel", 9999)).toBe(720);
  expect(clampPaneWidth("panel", 500)).toBe(500);
});

test("a width that is not a number is the pane's default", () => {
  expect(clampPaneWidth("sidebar", Number.NaN)).toBe(288);
  expect(clampPaneWidth("panel", Number.POSITIVE_INFINITY)).toBe(400);
  expect(paneLimits.sidebar.fallback).toBe(288);
  expect(paneLimits.panel.fallback).toBe(400);
});

test("a stored width is read back, held to the range, or ignored", () => {
  expect(parsePaneWidth("sidebar", "340")).toBe(340);
  expect(parsePaneWidth("sidebar", "9000")).toBe(420);
  expect(parsePaneWidth("panel", "10")).toBe(320);
  expect(parsePaneWidth("panel", "wide")).toBeUndefined();
  expect(parsePaneWidth("panel", "")).toBeUndefined();
  expect(parsePaneWidth("panel", null)).toBeUndefined();
  expect(parsePaneWidth("panel", undefined)).toBeUndefined();
});

test("dragging the sidebar's right edge right widens it, the panel's left edge left widens it", () => {
  expect(draggedPaneWidth("sidebar", 288, 40)).toBe(328);
  expect(draggedPaneWidth("sidebar", 288, -500)).toBe(260);
  expect(draggedPaneWidth("sidebar", 288, 500)).toBe(420);
  expect(draggedPaneWidth("panel", 400, -50)).toBe(450);
  expect(draggedPaneWidth("panel", 400, 500)).toBe(320);
  expect(draggedPaneWidth("panel", 400, -500)).toBe(720);
});
