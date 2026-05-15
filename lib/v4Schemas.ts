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

// ─────────────────────────────────────────────────────────────────────────
// Auto-callouts z Bounding Boxes (Faza 3 z deep research).
// Gemini 2.5 Pro Vision identyfikuje hardware interface points na zdjeciu
// produktu (smartwatch, opaska, tracker) — przyciski, porty, czujniki,
// wskazniki — i zwraca bounding boxy + labele. Frontend konwertuje na
// elementy strony: image (zdjecie) + N callouts (line + text label).
// ─────────────────────────────────────────────────────────────────────────

export const CalloutSchema = z.object({
  label_pl: z.string().describe("Krotki label po polsku, 1-3 slowa np. 'Przycisk SOS', 'Port USB-C', 'Czujnik tetna'"),
  label_en: z.string().optional().describe("Angielska wersja (gdy multilang generation)"),
  description: z.string().optional().describe("Dluzsze wyjasnienie do uzycia w treści instrukcji (1-2 zdania)"),
  // Bounding box jako 4 osobne pola — Gemini structured output lepiej radzi sobie
  // z plain numerami niz z z.tuple. Normalized [0-1000] per Gemini Vision standard.
  bbox_ymin: z.number().describe("Top edge bbox, 0-1000 (0=top of image)"),
  bbox_xmin: z.number().describe("Left edge bbox, 0-1000 (0=left of image)"),
  bbox_ymax: z.number().describe("Bottom edge bbox, 0-1000"),
  bbox_xmax: z.number().describe("Right edge bbox, 0-1000"),
});
export type Callout = z.infer<typeof CalloutSchema>;

export const CalloutsResponseSchema = z.object({
  product_description: z.string().optional().describe(
    "Krotka identyfikacja produktu na zdjeciu (1 zdanie) — pomaga w prompcie pozniej",
  ),
  callouts: z.array(CalloutSchema).describe("Lista hardware interface points zidentyfikowanych na zdjeciu"),
});
export type CalloutsResponse = z.infer<typeof CalloutsResponseSchema>;

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
    // Gemini API nie obsluguje tuple (prefixItems / heterogenous items).
    // Uniform array of two numbers [min_mhz, max_mhz] zamiast tuple.
    range_mhz: z.array(z.number()).length(2).describe("[min_mhz, max_mhz]"),
  })).optional().describe("Pasma testowane w raporcie"),
  applied_standards: z.array(z.string()).optional().describe(
    "Normy do ktorych raport sie odnosi np. 'EN 62209-1', 'EN 62209-2', 'IEC 62209', 'FCC OET 65'",
  ),
  ip_rating: z.string().optional().describe("IP rating z raportu jezeli pomyslnie zalaczone np. 'IP67'"),
  notes: z.string().optional().describe("Dodatkowe uwagi z raportu (krotko, 1-3 zdania)"),
});
export type SarReport = z.infer<typeof SarReportSchema>;

// ─────────────────────────────────────────────────────────────────────────
// Extract-structured per `doc.kind`. Kazdy reference_doc moze byc innego
// typu (tech spec, deklaracja CE, instrukcja, raport SAR, EMC, RoHS, ...) —
// AI dostaje schemę dopasowana do typu i wyciaga odpowiednie wartosci.
// GenericDocSchema sluzy jako fallback dla kind='other' lub null.
// ─────────────────────────────────────────────────────────────────────────

export const TechSpecSchema = z.object({
  device_model: z.string().describe("Model urzadzenia"),
  manufacturer: z.string().optional(),
  battery_mah: z.number().optional().describe("Pojemnosc baterii w mAh"),
  battery_v: z.number().optional().describe("Napiecie baterii w V"),
  ip_rating: z.string().optional().describe("Stopien ochrony np. 'IP67', 'IP68'"),
  weight_g: z.number().optional().describe("Waga w gramach"),
  dimensions_mm: z.object({
    w: z.number().describe("Szerokosc mm"),
    h: z.number().describe("Wysokosc mm"),
    d: z.number().describe("Glebokosc mm"),
  }).optional().describe("Wymiary urzadzenia"),
  display: z.object({
    size_inch: z.number().optional(),
    resolution: z.string().optional().describe("np. '240x240'"),
    type: z.string().optional().describe("np. 'TFT', 'AMOLED'"),
  }).optional(),
  operating_temp_c: z.object({
    min: z.number(),
    max: z.number(),
  }).optional().describe("Temperatura pracy w stopniach C"),
  frequencies: z.array(z.object({
    band: z.string(),
    range_mhz: z.array(z.number()).length(2),
  })).optional(),
  connectivity: z.array(z.string()).optional().describe("np. ['4G LTE', 'Bluetooth 5.0', 'Wi-Fi 2.4GHz', 'GPS']"),
  sensors: z.array(z.string()).optional().describe("np. ['akcelerometr', 'puls', 'SpO2']"),
  feature_descriptions: z.array(z.object({
    feature: z.string().describe("Nazwa funkcji np. 'Przycisk SOS', 'Monitor pulsu', 'Geofencing', 'Powiadomienia z telefonu'"),
    description: z.string().describe("Opis dzialania 1-3 zdania — co robi i jak uzytkownik z tego korzysta"),
  })).optional().describe("Opisy funkcji urzadzenia — przydatne do generacji sekcji 'Glowne funkcje' w QSG"),
  key_use_cases: z.array(z.string()).optional().describe(
    "Glowne scenariusze uzycia urzadzenia, ktore producent eksponuje (np. 'Monitorowanie dziecka w drodze do szkoly', 'Tracking aktywnosci sportowej')",
  ),
  notes: z.string().optional(),
});
export type TechSpec = z.infer<typeof TechSpecSchema>;

export const DeclarationCeSchema = z.object({
  device_model: z.string().describe("Model urzadzenia z deklaracji"),
  manufacturer_name: z.string().describe("Nazwa producenta"),
  manufacturer_address: z.string().optional().describe("Adres producenta"),
  declared_standards: z.array(z.string()).optional().describe(
    "Normy do ktorych deklarujemy zgodnosc np. 'EN 301 489-1', 'EN 62368-1', 'EN 50566'",
  ),
  applied_directives: z.array(z.string()).optional().describe(
    "Dyrektywy do ktorych deklarujemy np. 'RED 2014/53/EU', 'RoHS 2011/65/EU'",
  ),
  declaration_date: z.string().optional().describe("Data deklaracji YYYY-MM-DD"),
  declaration_place: z.string().optional().describe("Miejsce wystawienia np. 'Warszawa'"),
  signatory_name: z.string().optional().describe("Imie i nazwisko sygnatariusza"),
  signatory_position: z.string().optional().describe("Stanowisko sygnatariusza"),
  notified_body: z.string().optional().describe("Jednostka notyfikowana (gdy wymagana) np. 'CE 2630'"),
  notes: z.string().optional(),
});
export type DeclarationCe = z.infer<typeof DeclarationCeSchema>;

export const ManufacturerManualSchema = z.object({
  device_model: z.string(),
  manufacturer: z.string().optional(),
  language: z.string().optional().describe("Jezyk dokumentu np. 'en', 'zh', 'pl'"),
  sections_found: z.array(z.string()).optional().describe(
    "Lista rozdzialow / tematow ktore manual pokrywa np. ['First setup', 'Charging', 'SIM card', 'SOS button', 'Warranty']",
  ),
  key_specs: z.array(z.object({
    label: z.string().describe("np. 'Battery', 'IP rating', 'Frequencies'"),
    value: z.string().describe("Surowa wartosc jak w manualu"),
  })).optional().describe("Kluczowe specyfikacje wymienione w manualu"),
  feature_descriptions: z.array(z.object({
    feature: z.string().describe("Nazwa funkcji urzadzenia np. 'Przycisk SOS', 'Monitor pulsu', 'GPS tracking', 'Geofencing/Strefy bezpieczenstwa'"),
    description: z.string().describe(
      "Pelen opis dzialania 2-5 zdan — jak funkcja dziala, kiedy sie wlacza, jakie ma ograniczenia. Cytuj producenta tam gdzie warto.",
    ),
  })).optional().describe(
    "BARDZO WAZNE: szczegolowe opisy funkcjonalnosci urzadzenia. To zrodlo do generacji sekcji 'Glowne funkcje' i opisow w QSG. Wyciagnij KAZDA funkcje opisana w manualu, nie tylko 3-4 najwazniejsze.",
  ),
  setup_steps: z.array(z.object({
    step_number: z.number(),
    title: z.string().describe("np. 'Wloz karte SIM', 'Naladuj zegarek', 'Pobierz aplikacje'"),
    description: z.string().describe("Pelny opis kroku z manualu"),
  })).optional().describe("Krok-po-kroku procedura pierwszego uruchomienia urzadzenia"),
  app_pairing: z.object({
    app_name: z.string().optional().describe("Nazwa aplikacji do parowania np. 'CALMEAN', 'Setracker'"),
    procedure: z.string().optional().describe("Pelny opis procesu parowania zegarka z aplikacja"),
    qr_code_required: z.boolean().optional(),
  }).optional().describe("Procedura parowania urzadzenia z aplikacja mobilna"),
  key_procedures: z.array(z.object({
    title: z.string().describe("np. 'Jak wlaczyc SOS', 'Jak zaktualizowac firmware', 'Jak zresetowac'"),
    summary: z.string().describe("Pelny opis kroku — 2-5 zdan zeby user mogl powtorzyc"),
  })).optional().describe("Procedury operacyjne (poza initial setup) — np. SOS, reset, aktualizacja"),
  troubleshooting: z.array(z.object({
    problem: z.string().describe("Opis problemu z manuala FAQ np. 'Zegarek nie laduje sie'"),
    solution: z.string().describe("Sugerowane rozwiazanie"),
  })).optional().describe("FAQ / troubleshooting z manuala — przydatne do sekcji 'Najczestsze problemy' w QSG"),
  warnings: z.array(z.string()).optional().describe("Ostrzezenia i przeciwwskazania z manuala"),
  notes: z.string().optional(),
});
export type ManufacturerManual = z.infer<typeof ManufacturerManualSchema>;

export const GenericDocSchema = z.object({
  detected_doc_type: z.string().describe(
    "Wykryty typ dokumentu — opis 1-2 slowa np. 'EMC test report', 'RoHS report', 'REACH compliance', 'RF test conditions', 'Risk assessment', 'Photos of device', 'User manual', 'SAR report', 'Technical specification', 'Other'",
  ),
  device_model: z.string().optional().describe("Model urzadzenia (jezeli wymieniony)"),
  manufacturer: z.string().optional(),
  certificate_number: z.string().optional().describe("Numer certyfikatu / raport ID jezeli istnieje"),
  test_lab: z.string().optional().describe("Laboratorium / instytucja wystawiajaca"),
  test_date: z.string().optional().describe("Data badania YYYY-MM-DD"),
  applicable_standards: z.array(z.string()).optional().describe(
    "Normy / dyrektywy ktorych dokument dotyczy",
  ),
  key_values: z.array(z.object({
    label: z.string().describe("Czytelna nazwa pola np. 'Battery capacity', 'Operating frequency', 'Max output power'"),
    value: z.string().describe("Surowa wartosc"),
    unit: z.string().optional().describe("Jednostka np. 'mAh', 'MHz', 'dBm'"),
  })).optional().describe(
    "Lista najistotniejszych wartosci wyciagnietych z dokumentu — to co bedzie pozniej wstawione w treści instrukcji zamiast placeholderow",
  ),
  feature_descriptions: z.array(z.object({
    feature: z.string().describe("Nazwa funkcji / sekcji"),
    description: z.string().describe("Pelny opis 2-5 zdan"),
  })).optional().describe(
    "Jezeli dokument zawiera opisy funkcji urzadzenia (czesto w manualach, broszurach, opisach produktowych) — wyciagnij je. To zrodlo do generacji opisow w QSG.",
  ),
  procedures: z.array(z.object({
    title: z.string().describe("np. 'Jak naladowac', 'Jak sparowac z aplikacja', 'Jak zresetowac'"),
    summary: z.string().describe("Pelny opis kroku — 2-5 zdan"),
  })).optional().describe("Procedury obslugi (jezeli dokument je zawiera) — krok-po-kroku jak cos zrobic"),
  warnings: z.array(z.string()).optional().describe("Ostrzezenia, ograniczenia, przeciwwskazania"),
  quoted_passages: z.array(z.object({
    context: z.string().describe("O czym jest fragment np. 'Charging instruction', 'IP rating note'"),
    text: z.string().describe("Cytat z dokumentu (do 200 znakow)"),
  })).optional().describe(
    "Wartosciowe cytaty z dokumentu ktore moga byc parafrazowane w QSG. Maks 5-10 cytatow.",
  ),
  summary: z.string().describe("Krotkie streszczenie dokumentu, 2-4 zdania — co tam jest i co przydatne dla generacji QSG"),
  notes: z.string().optional(),
});
export type GenericDoc = z.infer<typeof GenericDocSchema>;

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
