import { describe, it, expect } from "vitest";
import { auditProjectQuality, type ProjectForAudit } from "./v4QualityAudit";
import type { PageForValidation } from "./v4Validate";

function page(over: Partial<PageForValidation> = {}): PageForValidation {
  return {
    id: "p" + Math.random().toString(36).slice(2, 6),
    page_number: 1,
    width_mm: 76,
    height_mm: 76,
    template: "step",
    title: "OK",
    elements: [],
    ...over,
  };
}

function project(over: Partial<ProjectForAudit> = {}): ProjectForAudit {
  return { pages: [page()], referenceDocs: [], ...over };
}

describe("auditProjectQuality", () => {
  it("czysty projekt → ready=true, zero blokerów", () => {
    const r = auditProjectQuality(project());
    expect(r.verdict.ready).toBe(true);
    expect(r.verdict.blockers).toHaveLength(0);
    expect(r.layout.errors).toBe(0);
    expect(r.content.placeholders).toBe(0);
  });

  it("element poza stroną → bloker layoutu, ready=false", () => {
    const r = auditProjectQuality(project({
      pages: [page({ elements: [
        { id: "e1", type: "text", x_mm: 5, y_mm: 5, w_mm: 200, h_mm: 5, properties: { content: "x", font_size_pt: 9 } },
      ] })],
    }));
    expect(r.layout.byCode.out_of_bounds).toBeGreaterThanOrEqual(1);
    expect(r.verdict.ready).toBe(false);
    expect(r.verdict.blockers.some((b) => /poza stron|layout/i.test(b))).toBe(true);
  });

  it("font <6pt liczony jako layout, nie treść", () => {
    const r = auditProjectQuality(project({
      pages: [page({ elements: [
        { id: "e1", type: "text", x_mm: 5, y_mm: 5, w_mm: 40, h_mm: 5, properties: { content: "drobne", font_size_pt: 4 } },
      ] })],
    }));
    expect(r.layout.byCode.tiny_font).toBe(1);
    expect(r.content.placeholders).toBe(0);
  });

  it("placeholder liczony jako luka treści, z lokalizacją strony", () => {
    const r = auditProjectQuality(project({
      pages: [page({ page_number: 7, elements: [
        { id: "e1", type: "text", x_mm: 5, y_mm: 5, w_mm: 40, h_mm: 10, properties: { content: "⚠️ DO UZUPEŁNIENIA: tel BOK", font_size_pt: 9 } },
      ] })],
    }));
    expect(r.content.placeholders).toBe(1);
    expect(r.content.placeholderDetails[0].page_number).toBe(7);
    expect(r.verdict.ready).toBe(false);
  });

  it("pokrycie ekstrakcji liczone z referenceDocs", () => {
    const r = auditProjectQuality(project({
      referenceDocs: [
        { name: "spec.xlsx", kind: "tech_spec", hasStructured: false, hasSummary: true },
        { name: "sar.pdf", kind: "other", hasStructured: true, hasSummary: true },
        { name: "ce.pdf", kind: "declaration_ce", hasStructured: true, hasSummary: true },
      ],
    }));
    expect(r.sources.total).toBe(3);
    expect(r.sources.withStructured).toBe(2);
    expect(r.sources.coveragePct).toBe(67);
    // dokument bez ekstrakcji strukturalnej jest sygnalizowany
    expect(r.sources.missingStructured.map((d) => d.name)).toContain("spec.xlsx");
  });

  it("agreguje problemy z wielu stron", () => {
    const r = auditProjectQuality(project({
      pages: [
        page({ page_number: 1, elements: [
          { id: "a", type: "text", x_mm: 5, y_mm: 5, w_mm: 200, h_mm: 5, properties: { content: "x", font_size_pt: 9 } },
        ] }),
        page({ page_number: 2, elements: [
          { id: "b", type: "text", x_mm: 5, y_mm: 5, w_mm: 40, h_mm: 5, properties: { content: "y", font_size_pt: 3 } },
        ] }),
      ],
    }));
    expect(r.layout.byCode.out_of_bounds).toBe(1);
    expect(r.layout.byCode.tiny_font).toBe(1);
    expect(r.perPage).toHaveLength(2);
  });
});
