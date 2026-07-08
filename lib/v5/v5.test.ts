import { describe, it, expect } from "vitest";
import { classifySourceFile } from "./classify";
import { mergeFragments } from "./merge";
import { scanGapMarkers, BookletSchema, type Booklet } from "./compose";
import { runQsgGate } from "./qa";
import { DeviceKBSchema, type DeviceKB } from "./types";

const src = (doc: string) => [{ source_doc: doc, confidence: "high" as const }];

function kbWith(over: Partial<DeviceKB> = {}): DeviceKB {
  return DeviceKBSchema.parse({
    identity: {
      model_code: { value: "GJD.16", sources: src("spec.xlsx") },
      manufacturer: { value: { name: "Lagenio" }, sources: src("doc.pdf") },
    },
    hardware: {
      battery: {
        value: { capacity_mah: 700, removable: false },
        sources: src("spec.xlsx"),
      },
    },
    radio: { bands: [{ tech: "LTE B20", max_power: "23 dBm", sources: src("rf.pdf") }] },
    sar: {
      results: [{ position: "limb 0mm", value_w_kg: 1.2, limit_w_kg: 4, sources: src("sar.pdf") }],
    },
    regulatory: {},
    features: [],
    app_flow: { pairing_steps: [] },
    safety: [],
    package_contents: [],
    support: {},
    ...over,
  });
}

describe("classify — deterministyczne reguły na realnym korpusie GJD.16", () => {
  const cases: Array<[string, string]> = [
    ["S24120904803001-SAR_已签章.pdf", "sar_report"],
    ["S24120904802001-WIFI 2.4G_已签章.pdf", "rf_test_report"],
    ["S24120904801001-EMC_已签章.pdf", "emc_test_report"],
    ["S24120904804001-Safety_已签章.pdf", "safety_test_report"],
    ["Appendix C - LTE - Blocking- Band 8 20 .pdf", "rf_test_report"],
    ["manual----最大功率和警告语在最后一页.pdf", "manufacturer_manual"],
    ["Instrukcja funkcji AI.pdf", "feature_guide"],
    ["deklaracja_zgodnosci_ue_smartwatch gjd.16_signed_ssp.pdf", "declaration_ce"],
    ["Declaration of Conformity RE Directive----DOC文件 K9.docx", "declaration_ce"],
    ["EMC EFGX25020142-IE-01 RED Evaluation----CE NB证书.pdf", "nb_certificate"],
    ["FTC25076029-1 RoHS报告.pdf", "rohs_reach"],
    ["FTC25076029-2 REACH.pdf", "rohs_reach"],
    ["RED Risk Assessment----风险评估.docx", "risk_assessment"],
    ["EUT PHOTO.pdf", "product_photos"],
    ["波兰设备服务器通讯协议V1.0.docx", "protocol_spec"],
  ];
  for (const [name, kind] of cases) {
    it(`${name} → ${kind}`, async () => {
      const res = await classifySourceFile({ name, mimeType: "application/pdf" });
      expect(res.kind).toBe(kind);
    });
  }
  it("xlsx bez dopasowania nazwy → tech_spec po MIME", async () => {
    const res = await classifySourceFile({
      name: "Lagenio K9 - GJD16.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    expect(res.kind).toBe("tech_spec");
  });
});

describe("mergeFragments", () => {
  it("dedupe tablic i wygrana skalaru wg priorytetu źródła + rejestracja konfliktu", () => {
    const specFrag = kbWith();
    const manualFrag = kbWith({
      hardware: {
        battery: { value: { capacity_mah: 650 }, sources: src("manual.pdf") },
      },
      radio: {
        bands: [
          { tech: "LTE B20", max_power: "23 dBm", sources: src("manual.pdf") },
          { tech: "GSM 900", max_power: "33 dBm", sources: src("manual.pdf") },
        ],
      },
    } as Partial<DeviceKB>);
    const { kb, conflicts } = mergeFragments([
      { kind: "manufacturer_manual", fragment: manualFrag },
      { kind: "tech_spec", fragment: specFrag },
    ]);
    // spec (wyższy priorytet) wygrywa pojemność baterii
    expect(kb.hardware.battery?.value.capacity_mah).toBe(700);
    expect(conflicts.some((c) => c.path.includes("battery"))).toBe(true);
    // pasma: LTE B20 zdeduplikowane po treści, GSM 900 dodane
    expect(kb.radio.bands.map((b) => b.tech).sort()).toEqual(["GSM 900", "LTE B20"]);
  });
});

describe("scanGapMarkers", () => {
  it("znajduje markery «BRAK:» w dowolnym zagnieżdżeniu", () => {
    const booklet = {
      meta: {
        documentId: "x",
        language: "PL",
        languageLabel: "PL",
        device: "X",
        title: "t",
        pageSizeMm: { width: 72, height: 72 },
      },
      branding: { company: "LOCON" },
      pages: [
        { type: "content", blocks: [{ kind: "paragraph", text: "Moc: «BRAK: radio.bands»" }] },
        { type: "content" },
        { type: "content" },
        { type: "content", nested: { deep: "SAR «BRAK: sar.results» W/kg" } },
      ],
    } as unknown as Booklet;
    expect(scanGapMarkers(booklet)).toEqual(["radio.bands", "sar.results"]);
  });
});

describe("runQsgGate", () => {
  const fullBooklet = BookletSchema.parse({
    meta: {
      documentId: "gjd16-qsg-pl",
      language: "PL",
      languageLabel: "PL",
      device: "GJD16",
      title: "QSG",
      pageSizeMm: { width: 72, height: 72 },
    },
    branding: { company: "LOCON" },
    pages: [
      { type: "content", variant: "cover", coverConfig: {} },
      {
        type: "content",
        variant: "qr",
        contactPage: { url: "https://locon.pl/instrukcje/gjd16" },
      },
      {
        type: "content",
        blocks: [
          {
            kind: "paragraph",
            text:
              "Smartwatch GJD.16 przeznaczony jest do lokalizacji dzieci. Producent: Lagenio. " +
              "Ładowanie 5V przez kabel magnetyczny. Bateria wbudowana.",
          },
        ],
      },
      { type: "content", frequencyPage: { rows: [] } },
      { type: "content", powerTablePage: { rows: [] } },
      { type: "content", warningsPage: {} },
      { type: "content", safetyPage: {} },
      { type: "content", sarPage: {} },
      { type: "content", weeePage: {} },
      { type: "content", disposalPage: {} },
      {
        type: "content",
        cePage: {
          text: "Lagenio deklaruje zgodność z dyrektywą 2014/53/UE. Pełny tekst deklaracji zgodności: https://locon.pl/doc",
        },
      },
    ],
  });

  it("kompletny booklet + kompletna KB → READY", () => {
    const report = runQsgGate({ kb: kbWith(), booklet: fullBooklet, overflows: [] });
    const blockers = report.checks.filter((c) => !c.ok && c.severity === "blocker");
    expect(blockers).toEqual([]);
    expect(report.ready).toBe(true);
  });

  it("brak strony SAR i pasm w KB → blockery", () => {
    const noSar = {
      ...fullBooklet,
      pages: fullBooklet.pages.filter((p) => !("sarPage" in p) && !("frequencyPage" in p)),
    };
    const kb = kbWith({ radio: { bands: [] }, sar: { results: [] } } as Partial<DeviceKB>);
    const report = runQsgGate({ kb, booklet: noSar, overflows: [] });
    expect(report.ready).toBe(false);
    const failed = report.checks.filter((c) => !c.ok).map((c) => c.id);
    expect(failed).toContain("QSG-03");
    expect(failed).toContain("MAN-05");
  });

  it("pozostałość nazwy z szablonu i overflow → blockery GEN-03/GEN-04", () => {
    const report = runQsgGate({
      kb: kbWith(),
      booklet: fullBooklet,
      overflows: [{ pageIndex: 3, label: "SPECYFIKACJA", overflowPx: 14 }],
      forbiddenTemplateNames: ["lagenio"], // nazwa własna urządzenia — NIE może być blockerem
    });
    expect(report.checks.find((c) => c.id === "GEN-03")?.ok).toBe(true);
    expect(report.checks.find((c) => c.id === "GEN-04")?.ok).toBe(false);
    const report2 = runQsgGate({
      kb: kbWith(),
      booklet: fullBooklet,
      overflows: [],
      forbiddenTemplateNames: ["slay ai"], // stara nazwa — brak w treści → OK
    });
    expect(report2.checks.find((c) => c.id === "GEN-03")?.ok).toBe(true);
  });
});
