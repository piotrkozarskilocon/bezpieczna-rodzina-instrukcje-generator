import { describe, it, expect } from "vitest";
import {
  PatchOpSchema,
  SingleElementPatchResponseSchema,
  PageElementsPatchResponseSchema,
  CalloutSchema,
  CalloutsResponseSchema,
  SarMeasurementSchema,
  SarReportSchema,
  PageElementSchema,
} from "./v4Schemas";

describe("PatchOpSchema (RFC 6902)", () => {
  it("akceptuje replace op", () => {
    const result = PatchOpSchema.safeParse({
      op: "replace",
      path: "/properties/color",
      value: "#FFFFFF",
    });
    expect(result.success).toBe(true);
  });

  it("akceptuje remove op bez value", () => {
    const result = PatchOpSchema.safeParse({
      op: "remove",
      path: "/elements/3",
    });
    expect(result.success).toBe(true);
  });

  it("akceptuje add op z value jako liczba", () => {
    const result = PatchOpSchema.safeParse({
      op: "add",
      path: "/properties/font_size_pt",
      value: 14,
    });
    expect(result.success).toBe(true);
  });

  it("akceptuje move op z from", () => {
    const result = PatchOpSchema.safeParse({
      op: "move",
      path: "/elements/0",
      from: "/elements/3",
    });
    expect(result.success).toBe(true);
  });

  it("odrzuca nieznane op", () => {
    const result = PatchOpSchema.safeParse({
      op: "transform",
      path: "/x",
    });
    expect(result.success).toBe(false);
  });

  it("odrzuca brak path", () => {
    const result = PatchOpSchema.safeParse({
      op: "replace",
      value: "x",
    });
    expect(result.success).toBe(false);
  });
});

describe("PageElementsPatchResponseSchema", () => {
  it("akceptuje pusta liste patches", () => {
    const result = PageElementsPatchResponseSchema.safeParse({ patches: [] });
    expect(result.success).toBe(true);
  });

  it("akceptuje liste patches + opt rationale", () => {
    const result = PageElementsPatchResponseSchema.safeParse({
      patches: [
        { op: "replace", path: "/elements/0/properties/color", value: "#000000" },
        { op: "add", path: "/elements/-", value: { type: "text", x_mm: 5, y_mm: 5, w_mm: 60, h_mm: 5, properties: {} } },
      ],
      rationale: "Zmiana koloru + dodanie tekstu",
    });
    expect(result.success).toBe(true);
  });
});

describe("CalloutSchema (auto-callouts BBox)", () => {
  it("akceptuje minimalny callout (tylko label + bbox)", () => {
    const result = CalloutSchema.safeParse({
      label_pl: "Przycisk SOS",
      bbox_ymin: 100,
      bbox_xmin: 200,
      bbox_ymax: 200,
      bbox_xmax: 300,
    });
    expect(result.success).toBe(true);
  });

  it("akceptuje pelny callout z label_en + description", () => {
    const result = CalloutSchema.safeParse({
      label_pl: "Czujnik tętna",
      label_en: "Heart rate sensor",
      description: "Optyczny sensor PPG do pomiaru tętna podczas aktywności",
      bbox_ymin: 400,
      bbox_xmin: 450,
      bbox_ymax: 500,
      bbox_xmax: 550,
    });
    expect(result.success).toBe(true);
  });

  it("odrzuca brak label_pl", () => {
    const result = CalloutSchema.safeParse({
      bbox_ymin: 100,
      bbox_xmin: 200,
      bbox_ymax: 200,
      bbox_xmax: 300,
    });
    expect(result.success).toBe(false);
  });

  it("odrzuca brak bbox", () => {
    const result = CalloutSchema.safeParse({ label_pl: "X" });
    expect(result.success).toBe(false);
  });
});

describe("CalloutsResponseSchema", () => {
  it("akceptuje pusta liste callouts (Gemini moze nic nie znalezc)", () => {
    const result = CalloutsResponseSchema.safeParse({ callouts: [] });
    expect(result.success).toBe(true);
  });

  it("akceptuje liste 3 callouts + product_description", () => {
    const result = CalloutsResponseSchema.safeParse({
      product_description: "Smartwatch dziecięcy GJD.16 — okrągła tarcza, pasek silikonowy",
      callouts: [
        { label_pl: "Przycisk SOS", bbox_ymin: 100, bbox_xmin: 850, bbox_ymax: 200, bbox_xmax: 950 },
        { label_pl: "Ekran dotykowy", bbox_ymin: 200, bbox_xmin: 250, bbox_ymax: 750, bbox_xmax: 750 },
        { label_pl: "Port USB-C", bbox_ymin: 950, bbox_xmin: 450, bbox_ymax: 1000, bbox_xmax: 550 },
      ],
    });
    expect(result.success).toBe(true);
  });
});

describe("SarMeasurementSchema", () => {
  it("akceptuje typowy pomiar SAR 10g (EU/ICNIRP)", () => {
    const result = SarMeasurementSchema.safeParse({
      value_w_per_kg: 0.78,
      averaging_mass: "10g",
      band: "GSM900",
      frequency_mhz: 900,
      separation_distance_mm: 0,
    });
    expect(result.success).toBe(true);
  });

  it("akceptuje minimal — tylko value + averaging_mass", () => {
    const result = SarMeasurementSchema.safeParse({
      value_w_per_kg: 1.2,
      averaging_mass: "1g",
    });
    expect(result.success).toBe(true);
  });

  it("odrzuca averaging_mass spoza enum", () => {
    const result = SarMeasurementSchema.safeParse({
      value_w_per_kg: 0.5,
      averaging_mass: "5g",
    });
    expect(result.success).toBe(false);
  });
});

describe("SarReportSchema", () => {
  it("akceptuje typowy raport SAR (smartwatch dziecięcy)", () => {
    const result = SarReportSchema.safeParse({
      device_model: "GJD.16",
      manufacturer: "Locon Sp. z o.o.",
      test_lab: "SGS-CSTC",
      test_date: "2025-06-15",
      certificate_number: "SGS25060123",
      sar_head_max: {
        value_w_per_kg: 0.42,
        averaging_mass: "10g",
        band: "LTE Band 1",
        frequency_mhz: 2100,
      },
      sar_body_max: {
        value_w_per_kg: 0.78,
        averaging_mass: "10g",
        band: "LTE Band 7",
        frequency_mhz: 2600,
        separation_distance_mm: 5,
      },
      applied_standards: ["EN 62209-1", "EN 62209-2", "IEC 62209-1528"],
      ip_rating: "IP67",
      notes: "Wszystkie pomiary poniżej limitu 2.0 W/kg.",
    });
    expect(result.success).toBe(true);
  });

  it("akceptuje minimal — tylko device_model", () => {
    const result = SarReportSchema.safeParse({ device_model: "Locon Watch X" });
    expect(result.success).toBe(true);
  });

  it("odrzuca brak device_model", () => {
    const result = SarReportSchema.safeParse({ ip_rating: "IP67" });
    expect(result.success).toBe(false);
  });
});

describe("PageElementSchema (RFC 6902 patch values)", () => {
  it("akceptuje element image z grayscale + opacity", () => {
    const result = PageElementSchema.safeParse({
      type: "image",
      x_mm: 5,
      y_mm: 5,
      w_mm: 60,
      h_mm: 40,
      properties: {
        image_id: "abc-123",
        fit_mode: "contain",
        opacity: 0.15,
        grayscale: true,
      },
    });
    expect(result.success).toBe(true);
  });

  it("akceptuje element text z polskimi znakami", () => {
    const result = PageElementSchema.safeParse({
      type: "text",
      x_mm: 3,
      y_mm: 3,
      w_mm: 70,
      h_mm: 4,
      properties: { content: "Bezpieczna Rodzina — Locon Sp. z o.o.", font_size_pt: 8 },
    });
    expect(result.success).toBe(true);
  });

  it("odrzuca element z nieznanym type", () => {
    const result = PageElementSchema.safeParse({
      type: "video",
      x_mm: 5,
      y_mm: 5,
      w_mm: 60,
      h_mm: 40,
      properties: {},
    });
    expect(result.success).toBe(false);
  });
});

describe("SingleElementPatchResponseSchema", () => {
  it("akceptuje patches dla pojedynczego elementu", () => {
    const result = SingleElementPatchResponseSchema.safeParse({
      patches: [
        { op: "replace", path: "/properties/color", value: "#FFFFFF" },
        { op: "replace", path: "/properties/font_size_pt", value: 12 },
      ],
      rationale: "Zwiększenie kontrastu na ciemnym tle",
    });
    expect(result.success).toBe(true);
  });
});
