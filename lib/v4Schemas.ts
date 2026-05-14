/**
 * Zod schemas dla strukturalnych odpowiedzi AI (Anthropic tool_use).
 *
 * Zamiast prosić AI o JSON w odpowiedzi tekstowej i parsować z fallbackami
 * (parseJsonFromAi z 5 strategiami), używamy `tool_choice` z Anthropic API,
 * który WYMUSZA zgodność odpowiedzi z `input_schema` zdefiniowanym tu.
 *
 * Anthropic API zwraca content bloki typu "tool_use" z polem `input` które
 * jest już sparsowanym i zwalidowanym JSON-em. Eliminuje to całkowicie błędy
 * "Unexpected token", "fence-strip failed" itd.
 *
 * Schemy są też używane do walidacji odpowiedzi i typowania (z.infer).
 */

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────
// Element strony — wspólny "kształt" dla każdego elementu na canvasie
// ─────────────────────────────────────────────────────────────────────────

export const ElementTypeSchema = z.enum([
  "text",
  "image",
  "line",
  "rect",
  "qr",
  "page_number",
  "callout",
]);

/** Properties — luźny obiekt bo zależy od typu. Walidacja typu->properties
 *  jest po stronie serwera w replacePageElements(). Tu trzymamy minimum
 *  żeby AI miało elastyczność co do nazewnictwa właściwości. */
export const ElementPropertiesSchema = z.record(z.string(), z.any());

export const PageElementSchema = z.object({
  type: ElementTypeSchema,
  x_mm: z.number(),
  y_mm: z.number(),
  w_mm: z.number(),
  h_mm: z.number(),
  z_index: z.number().int().optional().default(0),
  rotation_deg: z.number().optional().default(0),
  properties: ElementPropertiesSchema,
});
export type PageElement = z.infer<typeof PageElementSchema>;

// ─────────────────────────────────────────────────────────────────────────
// Output dla ai-edit / apply-style / apply-design — cała lista elementów
// strony zostaje podmieniona na nową
// ─────────────────────────────────────────────────────────────────────────

export const PageElementsResponseSchema = z.object({
  elements: z.array(PageElementSchema),
});
export type PageElementsResponse = z.infer<typeof PageElementsResponseSchema>;

// ─────────────────────────────────────────────────────────────────────────
// Output dla ai-fix-element — pojedynczy element po poprawce
// ─────────────────────────────────────────────────────────────────────────

export const SingleElementResponseSchema = z.object({
  element: PageElementSchema,
});
export type SingleElementResponse = z.infer<typeof SingleElementResponseSchema>;

// ─────────────────────────────────────────────────────────────────────────
// RFC 6902 JSON Patch — wariant output dla edycji elementu/strony.
// Zamiast zwracac caly element (~500-2000 tokens output), AI zwraca tylko
// liste operacji `replace`/`add`/`remove` (1-50 tokens per operacja).
// Redukcja kosztu output o ~85% dla typowych poprawek.
//
// Zob. RFC 6902 (https://datatracker.ietf.org/doc/html/rfc6902):
//   - replace: zmiana wartosci w istniejacej sciezce
//   - add: dodanie nowego pola/elementu w sciezce
//   - remove: usuniecie wartosci/pola
//   - move/copy: rzadko uzywane przez nasz AI, akceptujemy w schemacie
//   - test: rzadko uzywane, dla atomowych checkpointow
// Sciezka jest JSON Pointer (RFC 6901), np. "/properties/color" lub
// "/properties/font_size_pt".
// ─────────────────────────────────────────────────────────────────────────

export const PatchOpSchema = z.object({
  op: z.enum(["replace", "add", "remove", "move", "copy", "test"]),
  path: z.string().describe("JSON Pointer (RFC 6901), np. '/properties/color'"),
  value: z.any().optional().describe("Nowa wartosc dla replace/add/test. Pomijane dla remove."),
  from: z.string().optional().describe("Sciezka zrodla dla move/copy."),
});
export type PatchOp = z.infer<typeof PatchOpSchema>;

export const SingleElementPatchResponseSchema = z.object({
  patches: z.array(PatchOpSchema).describe("Lista operacji RFC 6902 do zastosowania na elemencie"),
  rationale: z.string().optional().describe("Krotkie wyjasnienie zmian (1-2 zdania, opcjonalne)"),
});
export type SingleElementPatchResponse = z.infer<typeof SingleElementPatchResponseSchema>;

// ─────────────────────────────────────────────────────────────────────────
// Patches dla CALEJ STRONY (ai-edit, apply-design per-page).
// Paths z indeksami w array elements: /elements/3/properties/color,
// /elements/- dla append, /elements/0 dla replace whole element.
// AI generuje patches sekwencyjnie — kolejne moga zalezec od dodanych
// (RFC 6902 stosuje operacje w kolejnosci).
// ─────────────────────────────────────────────────────────────────────────

export const PageElementsPatchResponseSchema = z.object({
  patches: z.array(PatchOpSchema).describe(
    "Lista operacji RFC 6902 na dokumencie { elements: [...] }. Paths: '/elements/N/...' dla istniejacych, '/elements/-' dla append.",
  ),
  rationale: z.string().optional().describe("Krotkie wyjasnienie zmian (1-2 zdania)"),
});
export type PageElementsPatchResponse = z.infer<typeof PageElementsPatchResponseSchema>;

// ─────────────────────────────────────────────────────────────────────────
// Strukturalna ekstrakcja z raportow SAR (Faza 2 z deep research).
// AI (Gemini 2.5 Pro vision) czyta caly raport SAR i wyciaga znormalizowane
// wartosci do uzytku w generacji sekcji "Informacja SAR" w QSG/manualu.
//
// Dlaczego ten konkretnie shape: matches RED 2014/53/EU + FCC OET 65 typowe
// pola w raportach SAR; pola opcjonalne bo ne kazdy raport zawiera kazda
// kategorie (np. tablet vs smartwatch ma rozne pomiary).
// ─────────────────────────────────────────────────────────────────────────

export const SarMeasurementSchema = z.object({
  value_w_per_kg: z.number().describe("Wartosc SAR w W/kg"),
  averaging_mass: z.enum(["1g", "10g"]).describe("Standard usredniania (1g=FCC, 10g=ICNIRP/EU)"),
  band: z.string().optional().describe("Pasmo radiowe np. 'GSM900', 'LTE Band 1', 'WiFi 2.4GHz'"),
  frequency_mhz: z.number().optional().describe("Konkretna czestotliwosc pomiaru"),
  separation_distance_mm: z.number().optional().describe("Odleglosc cialo-urzadzenie przy pomiarze"),
});
export type SarMeasurement = z.infer<typeof SarMeasurementSchema>;

export const SarReportSchema = z.object({
  device_model: z.string().describe("Model urzadzenia z raportu np. 'GJD.16' lub 'Locon Watch Slay AI'"),
  manufacturer: z.string().optional().describe("Producent / autor raportu"),
  test_lab: z.string().optional().describe("Nazwa laboratorium pomiarowego"),
  test_date: z.string().optional().describe("Data badania YYYY-MM-DD"),
  certificate_number: z.string().optional().describe("Numer certyfikatu / raport ID"),
  sar_head_max: SarMeasurementSchema.optional().describe("Maksymalna wartosc SAR przy glowie"),
  sar_body_max: SarMeasurementSchema.optional().describe("Maksymalna wartosc SAR przy ciele"),
  sar_limb_max: SarMeasurementSchema.optional().describe("Maksymalna wartosc SAR konczyny (jezeli mierzone)"),
  all_measurements: z.array(SarMeasurementSchema).optional().describe(
    "Pelna lista pomiarow per pasmo/frekwencja (do detailed reporting)",
  ),
  frequencies_tested: z.array(z.object({
    band: z.string(),
    range_mhz: z.tuple([z.number(), z.number()]),
  })).optional().describe("Pasma testowane w raporcie"),
  applied_standards: z.array(z.string()).optional().describe(
    "Normy do ktorych raport sie odnosi np. 'EN 62209-1', 'EN 62209-2', 'IEC 62209', 'FCC OET 65'",
  ),
  ip_rating: z.string().optional().describe("IP rating z raportu jezeli pomyslnie zalaczone np. 'IP67'"),
  notes: z.string().optional().describe("Dodatkowe uwagi z raportu (krotko, 1-3 zdania)"),
});
export type SarReport = z.infer<typeof SarReportSchema>;

// ─────────────────────────────────────────────────────────────────────────
// Skeleton strony — używane przy /projects/generate
// ─────────────────────────────────────────────────────────────────────────

export const PageSkeletonSchema = z.object({
  page_number: z.number().int(),
  title: z.string(),
  template: z.enum([
    "cover",
    "toc",
    "step",
    "warranty_terms",
    "warranty_stamp",
    "contact",
    "blank",
  ]),
  width_mm: z.number().int(),
  height_mm: z.number().int(),
  brief: z.string().describe("1-3 zdaniowy opis co ma być na stronie, używany jako input do auto-populate"),
});
export type PageSkeleton = z.infer<typeof PageSkeletonSchema>;

export const SkeletonResponseSchema = z.object({
  pages: z.array(PageSkeletonSchema),
});
export type SkeletonResponse = z.infer<typeof SkeletonResponseSchema>;
