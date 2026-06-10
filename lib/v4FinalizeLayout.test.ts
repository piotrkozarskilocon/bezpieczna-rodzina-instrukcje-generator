import { describe, it, expect } from "vitest";
import { finalizePageLayout, type LayoutElement } from "./v4FinalizeLayout";

function txt(id: string, x: number, y: number, w: number, h: number, content = "tekst", font = 9, z = 1): LayoutElement {
  return { id, type: "text", x_mm: x, y_mm: y, w_mm: w, h_mm: h, z_index: z, properties: { content, font_size_pt: font } };
}

/** Sprawdza inwarianty layoutu: nic poza bounds + brak nakładania text-text. */
function assertClean(els: LayoutElement[], W = 76, H = 76, margin = 3) {
  for (const e of els) {
    expect(e.x_mm).toBeGreaterThanOrEqual(margin - 0.1);
    expect(e.y_mm).toBeGreaterThanOrEqual(margin - 0.1);
    expect(e.x_mm + e.w_mm).toBeLessThanOrEqual(W - margin + 0.1);
    expect(e.y_mm + e.h_mm).toBeLessThanOrEqual(H - margin + 0.1);
  }
  const t = els.filter((e) => e.type === "text" || e.type === "callout");
  for (let i = 0; i < t.length; i++) {
    for (let j = i + 1; j < t.length; j++) {
      const a = t[i], b = t[j];
      const overlap =
        a.x_mm + a.w_mm > b.x_mm + 0.05 && b.x_mm + b.w_mm > a.x_mm + 0.05 &&
        a.y_mm + a.h_mm > b.y_mm + 0.05 && b.y_mm + b.h_mm > a.y_mm + 0.05;
      expect(overlap).toBe(false);
    }
  }
}

describe("finalizePageLayout", () => {
  it("nie zmienia czystej strony", () => {
    const els = [txt("a", 5, 5, 60, 10), txt("b", 5, 20, 60, 10)];
    const r = finalizePageLayout(els, 76, 76);
    expect(r.changedIds).toHaveLength(0);
    assertClean(r.elements);
  });

  it("wciąga element wystający poza stronę do bounds", () => {
    const els = [txt("a", 5, 5, 200, 10)]; // w=200 na stronie 76
    const r = finalizePageLayout(els, 76, 76);
    expect(r.changedIds).toContain("a");
    assertClean(r.elements);
  });

  it("rozwiązuje 3 nakładające teksty → zero nakładań, w bounds", () => {
    const els = [txt("a", 5, 10, 60, 15, "A", 9, 1), txt("b", 5, 12, 60, 15, "B", 9, 2), txt("c", 5, 14, 60, 15, "C", 9, 3)];
    const r = finalizePageLayout(els, 76, 76);
    assertClean(r.elements);
  });

  it("ciasna strona: kompresuje i nie zostawia nakładań", () => {
    const els = [
      txt("a", 5, 5, 66, 22, "dużo tekstu ".repeat(10), 9, 1),
      txt("b", 5, 8, 66, 22, "więcej tekstu ".repeat(10), 9, 2),
      txt("c", 5, 11, 66, 22, "jeszcze tekstu ".repeat(10), 9, 3),
    ];
    const r = finalizePageLayout(els, 76, 76);
    assertClean(r.elements);
  });

  it("nie mutuje wejścia (immutability)", () => {
    const els = [txt("a", 5, 5, 200, 10)];
    const snapshot = JSON.parse(JSON.stringify(els));
    finalizePageLayout(els, 76, 76);
    expect(els).toEqual(snapshot);
  });

  it("flaguje needs_split gdy tekst nie mieści się nawet przy 6pt", () => {
    // maleńki box + bardzo dużo tekstu → nie zmieści się przy 6pt
    const els = [txt("a", 5, 5, 20, 6, "bardzo długi tekst ".repeat(40), 9)];
    const r = finalizePageLayout(els, 76, 76);
    expect(r.needsSplit).toContain("a");
  });
});
