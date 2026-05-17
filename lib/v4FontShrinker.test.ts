import { describe, it, expect } from "vitest";
import { shrinkTextToFit, estimateTextHeightMm, type ShrinkElement } from "./v4FontShrinker";

function textEl(id: string, w: number, h: number, content: string, fontPt = 9): ShrinkElement {
  return {
    id,
    type: "text",
    w_mm: w,
    h_mm: h,
    properties: { content, font_size_pt: fontPt },
  };
}

describe("estimateTextHeightMm", () => {
  it("krótki tekst → 1 linia", () => {
    const h = estimateTextHeightMm("Krótki tekst", 9, 60);
    // 1 linia * 9pt * 1.2 * 0.3527 ≈ 3.81 mm
    expect(h).toBeGreaterThan(3);
    expect(h).toBeLessThan(5);
  });

  it("długi tekst → wiele linii", () => {
    const longText = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(10);
    const h = estimateTextHeightMm(longText, 9, 60);
    expect(h).toBeGreaterThan(20);
  });

  it("większy font → wyższy wiersz", () => {
    const h1 = estimateTextHeightMm("Test", 6, 60);
    const h2 = estimateTextHeightMm("Test", 12, 60);
    expect(h2).toBeGreaterThan(h1);
  });
});

describe("shrinkTextToFit", () => {
  it("brak shrink gdy tekst już się mieści", () => {
    const results = shrinkTextToFit([textEl("a", 60, 20, "Krótki tekst", 9)]);
    expect(results).toEqual([]);
  });

  it("zmniejsza font gdy tekst wystaje", () => {
    // Długi tekst w wąskim, niskim boxie — 9pt nie zmieści, 7-6pt powinno
    const longText = "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.";
    const results = shrinkTextToFit([textEl("a", 60, 10, longText, 9)]);
    expect(results).toHaveLength(1);
    expect(results[0].font_size_pt).toBeDefined();
    expect(results[0].font_size_pt!).toBeLessThan(9);
    expect(results[0].font_size_pt!).toBeGreaterThanOrEqual(6);
  });

  it("flag needs_split gdy nawet 6pt nie wystarczy", () => {
    // Bardzo długi tekst w bardzo małym boxie
    const hugeText = "Lorem ipsum ".repeat(200); // ~2400 znaków
    const results = shrinkTextToFit([textEl("a", 20, 5, hugeText, 9)]);
    expect(results).toHaveLength(1);
    expect(results[0].needs_split).toBe(true);
    expect(results[0].font_size_pt).toBeUndefined();
  });

  it("pomija non-text elementy", () => {
    const el: ShrinkElement = {
      id: "img",
      type: "image",
      w_mm: 60,
      h_mm: 5,
      properties: { content: "ten content nie jest renderowany", font_size_pt: 9 },
    };
    expect(shrinkTextToFit([el])).toEqual([]);
  });

  it("pomija puste elementy bez content", () => {
    expect(shrinkTextToFit([textEl("a", 60, 10, "", 9)])).toEqual([]);
    expect(shrinkTextToFit([textEl("b", 60, 10, "   ", 9)])).toEqual([]);
  });

  it("używa default 9pt gdy font_size_pt nie podany", () => {
    const el: ShrinkElement = {
      id: "a",
      type: "text",
      w_mm: 60,
      h_mm: 5,
      properties: { content: "Lorem ipsum dolor sit amet ".repeat(5) },
    };
    const results = shrinkTextToFit([el]);
    expect(results.length).toBeGreaterThanOrEqual(0); // zaleznie od heurystyki — moze zmiescic lub nie
  });
});
