import { describe, it, expect } from "vitest";
import { clampToBounds, hasOutOfBoundsElements, type ClampElement } from "./v4BoundsClamp";

function el(id: string, x: number, y: number, w: number, h: number): ClampElement {
  return { id, type: "text", x_mm: x, y_mm: y, w_mm: w, h_mm: h };
}

describe("clampToBounds", () => {
  it("brak patches gdy wszystkie w bounds", () => {
    const patches = clampToBounds(
      [el("a", 5, 5, 30, 10), el("b", 10, 20, 40, 20)],
      76,
      76,
      3,
    );
    expect(patches).toEqual([]);
  });

  it("skraca w_mm gdy prawa krawędź poza marginesem", () => {
    // x=5, w=80 → x+w=85 > maxX (73) → w = 73-5 = 68
    const patches = clampToBounds([el("a", 5, 5, 80, 10)], 76, 76, 3);
    expect(patches).toHaveLength(1);
    expect(patches[0].w_mm).toBeCloseTo(68, 1);
    expect(patches[0].reason).toContain("x+w>73");
  });

  it("skraca h_mm gdy dolna krawędź poza marginesem", () => {
    const patches = clampToBounds([el("a", 5, 5, 60, 80)], 76, 76, 3);
    expect(patches).toHaveLength(1);
    expect(patches[0].h_mm).toBeCloseTo(68, 1); // 73 - 5
  });

  it("przesuwa x na margin gdy lewa krawędź < margin", () => {
    const patches = clampToBounds([el("a", -2, 10, 30, 10)], 76, 76, 3);
    expect(patches).toHaveLength(1);
    expect(patches[0].x_mm).toBe(3);
    expect(patches[0].w_mm).toBeCloseTo(25, 1); // 30 - shift(5)
  });

  it("flag too_small gdy po clampie wymiary minimalne", () => {
    // element w prawym dolnym rogu na marginie, ogromny — clamp przeniesie do minimum
    const patches = clampToBounds([el("a", 71, 71, 30, 30)], 76, 76, 3);
    expect(patches).toHaveLength(1);
    expect(patches[0].too_small).toBe(true);
  });

  it("kombinacja x i y poza bounds", () => {
    const patches = clampToBounds([el("a", -1, -2, 80, 90)], 76, 76, 3);
    expect(patches).toHaveLength(1);
    expect(patches[0].x_mm).toBe(3);
    expect(patches[0].y_mm).toBe(3);
    expect(patches[0].w_mm).toBeLessThanOrEqual(70);
    expect(patches[0].h_mm).toBeLessThanOrEqual(70);
  });

  it("tolerancja 0.05 mm — bardzo małe różnice nie generują patcha", () => {
    // Element prawie na granicy — y=3.02 (margin=3), różnica 0.02 < 0.05 tolerance
    const patches = clampToBounds([el("a", 3.02, 3.02, 60, 60)], 76, 76, 3);
    expect(patches).toEqual([]);
  });

  it("custom pageWidth (np. A6 105×148)", () => {
    // element wystaje poza A6 → clamp do 105-3=102
    const patches = clampToBounds([el("a", 5, 5, 110, 10)], 105, 148, 3);
    expect(patches).toHaveLength(1);
    expect(patches[0].w_mm).toBeCloseTo(97, 1); // 102 - 5
  });
});

describe("hasOutOfBoundsElements", () => {
  it("false gdy wszystkie w bounds", () => {
    expect(hasOutOfBoundsElements([el("a", 5, 5, 30, 10)], 76, 76, 3)).toBe(false);
  });

  it("true gdy element wystaje", () => {
    expect(hasOutOfBoundsElements([el("a", 5, 5, 80, 10)], 76, 76, 3)).toBe(true);
  });

  it("ignoruje tolerancję 0.05 mm", () => {
    // element y=73.03 z h=0 → maxY=73 → diff 0.03 < 0.05 OK
    expect(hasOutOfBoundsElements([el("a", 3, 3, 60, 70.03)], 76, 76, 3)).toBe(false);
  });
});
