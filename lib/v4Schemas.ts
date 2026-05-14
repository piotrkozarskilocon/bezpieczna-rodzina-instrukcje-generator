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
