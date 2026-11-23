import { describe, expect, it } from "vitest";
import {
  clampCoordinate,
  NORMALIZED_MAX,
  PERCENT_MAX,
  resolveCropRect,
  toNormalizedPoint,
  toViewportPixels,
  validateCoordinate,
} from "../src/computer";

describe("computer coordinate contracts", () => {
  const viewport = { width: 1920, height: 1080, scaleFactor: 1.25 };

  it("round-trips normalized 0..1000 and physical viewport pixels within <= 1px error", () => {
    const samples = [
      { x: 0, y: 0 },
      { x: 500, y: 500 },
      { x: 1000, y: 1000 },
      { x: 123, y: 876 },
      { x: 999, y: 1 },
    ];
    for (const norm of samples) {
      const px = toViewportPixels(norm, viewport, { unit: "normalized" });
      expect(px.x).toBeGreaterThanOrEqual(0);
      expect(px.x).toBeLessThan(viewport.width);
      expect(px.y).toBeGreaterThanOrEqual(0);
      expect(px.y).toBeLessThan(viewport.height);

      const backNorm = toNormalizedPoint(px, viewport);
      const backPx = toViewportPixels(backNorm, viewport, {
        unit: "normalized",
      });
      expect(Math.abs(backPx.x - px.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(backPx.y - px.y)).toBeLessThanOrEqual(1);
    }
  });

  it("converts percent (0..100) and pixel units accurately", () => {
    const center = toViewportPixels({ x: 50, y: 50 }, viewport, {
      unit: "percent",
    });
    expect(center.x).toBe(Math.round(0.5 * (viewport.width - 1)));
    expect(center.y).toBe(Math.round(0.5 * (viewport.height - 1)));

    const exact = toViewportPixels({ x: 320, y: 240 }, viewport, {
      unit: "pixel",
    });
    expect(exact).toEqual({ x: 320, y: 240 });
  });

  it("offsets GroundCascade crop coordinates into full-viewport physical pixels", () => {
    const crop = resolveCropRect(
      { x: 250, y: 250, width: 500, height: 500, unit: "normalized" },
      viewport,
    );
    expect(crop).toEqual({ x: 480, y: 270, width: 960, height: 540 });

    const topLeft = toViewportPixels({ x: 0, y: 0 }, viewport, {
      unit: "normalized",
      crop,
    });
    expect(topLeft).toEqual({ x: 480, y: 270 });

    const bottomRight = toViewportPixels(
      { x: NORMALIZED_MAX, y: NORMALIZED_MAX },
      viewport,
      { unit: "normalized", crop },
    );
    expect(bottomRight).toEqual({
      x: 480 + 960 - 1,
      y: 270 + 540 - 1,
    });
  });

  it("rejects out-of-bounds coordinates, invalid viewports, and out-of-bounds crops", () => {
    expect(() =>
      validateCoordinate({ x: -1, y: 100 }, viewport, "normalized"),
    ).toThrow(RangeError);
    expect(() =>
      validateCoordinate(
        { x: NORMALIZED_MAX + 1, y: 0 },
        viewport,
        "normalized",
      ),
    ).toThrow(RangeError);
    expect(() =>
      validateCoordinate({ x: PERCENT_MAX + 1, y: 0 }, viewport, "percent"),
    ).toThrow(RangeError);
    expect(() =>
      toViewportPixels({ x: 10, y: 10 }, { width: 0, height: 1080 }),
    ).toThrow(RangeError);
    expect(() =>
      resolveCropRect({ x: 800, y: 800, width: 300, height: 300 }, viewport),
    ).toThrow(RangeError);
  });

  it("clamps coordinates when clamp: true is passed", () => {
    expect(clampCoordinate(-20, 0, 1000)).toBe(0);
    expect(clampCoordinate(1500, 0, 1000)).toBe(1000);
    const clamped = toViewportPixels({ x: -50, y: 1500 }, viewport, {
      unit: "normalized",
      clamp: true,
    });
    expect(clamped).toEqual({ x: 0, y: viewport.height - 1 });
  });
});
