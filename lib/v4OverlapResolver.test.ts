import { describe, it, expect } from "vitest";
import { findOverlapGroups, resolveTextOverlaps, type OverlapElement } from "./v4OverlapResolver";

function el(id: string, type: string, x: number, y: number, w: number, h: number, z = 1): OverlapElement {
  return { id, type, x_mm: x, y_mm: y, w_mm: w, h_mm: h, z_index: z };
}

describe("findOverlapGroups", () => {
  it("zwraca pustą listę gdy żadne nie nakładają", () => {
    const groups = findOverlapGroups([
      el("a", "text", 5, 5, 30, 10),
      el("b", "text", 5, 20, 30, 10),
    ]);
    expect(groups).toEqual([]);
  });

  it("łączy 2 nakładające teksty w grupę", () => {
    const groups = findOverlapGroups([
      el("a", "text", 5, 5, 30, 10),
      el("b", "text", 10, 8, 30, 10),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].map((e) => e.id).sort()).toEqual(["a", "b"]);
  });

  it("transitive: A∩B, B∩C ale A nie ∩ C → wszystkie w 1 grupie", () => {
    const groups = findOverlapGroups([
      el("a", "text", 5, 5, 20, 10),
      el("b", "text", 10, 10, 20, 10),
      el("c", "text", 15, 14, 20, 10),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(3);
  });

  it("pomija non-text elementy", () => {
    const groups = findOverlapGroups([
      el("a", "text", 5, 5, 30, 10),
      el("r", "rect", 5, 5, 30, 10),
      el("l", "line", 5, 5, 30, 10),
    ]);
    expect(groups).toEqual([]);
  });

  it("traktuje callout jako text", () => {
    const groups = findOverlapGroups([
      el("t", "text", 5, 5, 30, 10),
      el("c", "callout", 8, 8, 30, 10),
    ]);
    expect(groups).toHaveLength(1);
  });
});

describe("resolveTextOverlaps", () => {
  it("3 nakładające teksty układane pionowo z gap 1mm", () => {
    const elements = [
      el("a", "text", 5, 10, 60, 15, 1),
      el("b", "text", 5, 12, 60, 15, 2),
      el("c", "text", 5, 14, 60, 15, 3),
    ];
    const patches = resolveTextOverlaps(elements, 76, 3, 1.0);
    // 'a' jest juz na top group (y=10) i jego h sie nie zmienia → NIE w patches
    // 'b' → y=26 (10+15+1), 'c' → y=42 (26+15+1)
    expect(patches).toHaveLength(2);
    const byId = new Map(patches.map((p) => [p.id, p]));
    expect(byId.has("a")).toBe(false);
    expect(byId.get("b")?.y_mm).toBeCloseTo(26, 1);
    expect(byId.get("c")?.y_mm).toBeCloseTo(42, 1);
  });

  it("nie modyfikuje gdy nic nie nakłada", () => {
    const elements = [
      el("a", "text", 5, 5, 30, 10),
      el("b", "text", 5, 20, 30, 10),
    ];
    const patches = resolveTextOverlaps(elements, 76);
    expect(patches).toEqual([]);
  });

  it("overflow: gdy nie mieści się, skraca h_mm do dostępnej przestrzeni", () => {
    const elements = [
      el("a", "text", 5, 60, 60, 15, 1),
      el("b", "text", 5, 62, 60, 15, 2),
    ];
    // pageHeight 76, margin 3 → maxY = 73
    // top = 60, cursor = 60. Element a (h=15) ma 73-60=13 → skrocony do 13
    // cursor po a: 60+13+1=74 → b nie miesci sie wcale (74 > 73)
    const patches = resolveTextOverlaps(elements, 76, 3, 1.0);
    const byId = new Map(patches.map((p) => [p.id, p]));
    expect(byId.get("a")?.h_mm).toBeCloseTo(13, 1);
    // b dostaje fallback "przesun na koniec, h=4"
    expect(byId.get("b")?.h_mm).toBe(4);
    expect(byId.get("b")?.reason).toContain("overflow");
  });

  it("zachowuje kolejnosc wg z_index", () => {
    const elements = [
      el("z3", "text", 5, 10, 60, 10, 3),
      el("z1", "text", 5, 12, 60, 10, 1),
      el("z2", "text", 5, 14, 60, 10, 2),
    ];
    const patches = resolveTextOverlaps(elements, 76, 3, 1.0);
    // Sortuj wg z_index: z1 (top), z2 (middle), z3 (bottom)
    // top y = min(10, 12, 14) = 10
    // z1 stays at 10 (zaden patch lub h_mm bez zmian) — ale y_mm zmieni z 12 → 10
    // z2 at 10+10+1=21, z3 at 21+10+1=32
    const byId = new Map(patches.map((p) => [p.id, p]));
    expect(byId.get("z1")?.y_mm).toBeCloseTo(10, 1);
    expect(byId.get("z2")?.y_mm).toBeCloseTo(21, 1);
    expect(byId.get("z3")?.y_mm).toBeCloseTo(32, 1);
  });
});
