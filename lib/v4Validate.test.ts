import { describe, it, expect } from "vitest";
import { validatePage, summarizeIssues, type PageForValidation, type ElementForValidation } from "./v4Validate";

function makePage(overrides: Partial<PageForValidation> = {}): PageForValidation {
  return {
    id: "page-1",
    page_number: 1,
    width_mm: 76,
    height_mm: 76,
    template: "step",
    title: "Test page",
    elements: [],
    ...overrides,
  };
}

function makeText(overrides: Partial<ElementForValidation> = {}): ElementForValidation {
  return {
    id: `el-${Math.random().toString(36).slice(2, 8)}`,
    type: "text",
    x_mm: 5,
    y_mm: 5,
    w_mm: 60,
    h_mm: 10,
    properties: { content: "OK", font_size_pt: 8 },
    ...overrides,
  };
}

describe("validatePage", () => {
  it("nie zglasza problemow gdy strona jest poprawna", () => {
    const page = makePage({
      title: "Bezpieczeństwo",
      elements: [makeText({ x_mm: 5, y_mm: 5, properties: { content: "treść", font_size_pt: 8 } })],
    });
    const issues = validatePage(page);
    expect(issues).toHaveLength(0);
  });

  it("wymaga title dla nie-cover stron", () => {
    const page = makePage({ template: "step", title: null });
    const issues = validatePage(page);
    expect(issues.some((i) => i.message.includes("nie ma tytułu"))).toBe(true);
  });

  it("nie wymaga title dla cover", () => {
    const page = makePage({ template: "cover", title: null });
    const issues = validatePage(page);
    expect(issues.some((i) => i.message.includes("nie ma tytułu"))).toBe(false);
  });

  it("wykrywa elementy poza marginesem 3mm", () => {
    const page = makePage({
      elements: [
        // Tylko 1mm od krawędzi (powinno być >= 3mm)
        makeText({ x_mm: 1, y_mm: 5, w_mm: 50, h_mm: 5 }),
      ],
    });
    const issues = validatePage(page);
    expect(
      issues.some((i) => i.message.toLowerCase().includes("margines") || i.message.toLowerCase().includes("bound")),
    ).toBe(true);
  });

  it("wykrywa elementy zerowych wymiarow", () => {
    const page = makePage({
      elements: [makeText({ w_mm: 0, h_mm: 0 })],
    });
    const issues = validatePage(page);
    expect(issues.some((i) => /wymiar|dimension|zerow/i.test(i.message))).toBe(true);
  });

  it("wykrywa placeholder DO UZUPEŁNIENIA jako non-AI-fixable", () => {
    const page = makePage({
      elements: [
        makeText({ properties: { content: "⚠️ DO UZUPEŁNIENIA: wartość SAR", font_size_pt: 8 } }),
      ],
    });
    const issues = validatePage(page);
    const placeholderIssue = issues.find((i) => /UPE[LŁ]NIEN|placeholder/i.test(i.message));
    expect(placeholderIssue).toBeDefined();
    expect(placeholderIssue?.ai_fixable).toBe(false);
  });

  it("wykrywa image element bez image_id (placeholder)", () => {
    const page = makePage({
      elements: [
        {
          id: "img-1",
          type: "image",
          x_mm: 10,
          y_mm: 10,
          w_mm: 30,
          h_mm: 30,
          properties: {}, // brak image_id
        },
      ],
    });
    const issues = validatePage(page);
    expect(issues.some((i) => /image_id|obraz/i.test(i.message))).toBe(true);
  });

  it("wykrywa image z opacity ekstremalnie nisko (prawie niewidoczny)", () => {
    const page = makePage({
      elements: [
        {
          id: "img-watermark",
          type: "image",
          x_mm: 10,
          y_mm: 10,
          w_mm: 30,
          h_mm: 30,
          properties: { image_id: "abc-123", opacity: 0.03 },
        },
      ],
    });
    const issues = validatePage(page);
    expect(issues.some((i) => /opacity|przezr|niewid/i.test(i.message))).toBe(true);
  });

  it("nie zglasza opacity 0.15 jako problem (typowy watermark)", () => {
    const page = makePage({
      elements: [
        {
          id: "img-watermark",
          type: "image",
          x_mm: 10,
          y_mm: 10,
          w_mm: 30,
          h_mm: 30,
          properties: { image_id: "abc-123", opacity: 0.15 },
        },
      ],
    });
    const issues = validatePage(page);
    expect(issues.some((i) => /opacity.*nisk/i.test(i.message))).toBe(false);
  });
});

describe("summarizeIssues", () => {
  it("liczy issues per severity", () => {
    const issues = [
      { severity: "error" as const, message: "a" },
      { severity: "error" as const, message: "b" },
      { severity: "warning" as const, message: "c" },
      { severity: "info" as const, message: "d" },
    ];
    const summary = summarizeIssues(issues);
    expect(summary.errors).toBe(2);
    expect(summary.warnings).toBe(1);
    expect(summary.infos).toBe(1);
  });

  it("dziala dla pustej listy", () => {
    const summary = summarizeIssues([]);
    expect(summary.errors).toBe(0);
    expect(summary.warnings).toBe(0);
    expect(summary.infos).toBe(0);
  });
});
