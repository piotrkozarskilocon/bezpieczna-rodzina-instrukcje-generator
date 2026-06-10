/**
 * Deterministyczna finalizacja layoutu strony — jedna czysta funkcja, która
 * iteracyjnie składa trzy warstwy obrony aż do zbieżności:
 *
 *   clamp (bounds) → resolve (overlap) → shrink (font) → powtórz
 *
 * Po co iteracja: clamp może przesunąć element tak, że pojawi się nowy overlap;
 * resolve może skompresować wysokości tak, że tekst wymaga mniejszego fontu;
 * shrink nie zmienia geometrii, ale stabilizuje. Pojedynczy przebieg (stary
 * auto-hook) zostawiał nakładania, które drugi przebieg usuwa.
 *
 * Funkcja PURE — nie dotyka bazy, nie mutuje wejścia. Zwraca nowe kopie
 * elementów + listę zmienionych id + listę id wymagających splitu strony
 * (tekst nie mieści się nawet przy 6pt — do auto-split / uwagi użytkownika).
 *
 * Wrapper DB (v4Edit.applyAutoDedupeOverlap) ładuje elementy raz, woła tę
 * funkcję i zapisuje TYLKO zmienione — to też usuwa N+1 (było: update per
 * element w wielu przebiegach).
 */

import { clampToBounds } from "./v4BoundsClamp";
import { resolveTextOverlaps } from "./v4OverlapResolver";
import { shrinkTextToFit } from "./v4FontShrinker";

export interface LayoutElement {
  id: string;
  type: string;
  x_mm: number;
  y_mm: number;
  w_mm: number;
  h_mm: number;
  z_index?: number | null;
  properties?: { content?: string; font_size_pt?: number; [k: string]: unknown };
}

export interface FinalizeResult {
  /** Nowe kopie elementów po finalizacji (wejście nietknięte). */
  elements: LayoutElement[];
  /** Id elementów, które faktycznie się zmieniły (geometria lub font). */
  changedIds: string[];
  /** Id elementów, których tekst nie mieści się nawet przy 6pt — strona
   *  wymaga splitu lub większego pola. */
  needsSplit: string[];
}

const EPS = 0.05;

export function finalizePageLayout(
  input: LayoutElement[],
  pageWidth: number,
  pageHeight: number,
  maxIter = 6,
): FinalizeResult {
  // Głęboka kopia — immutability (nie dotykamy wejścia).
  const els: LayoutElement[] = input.map((e) => ({
    ...e,
    properties: { ...(e.properties ?? {}) },
  }));
  const byId = new Map(els.map((e) => [e.id, e]));
  const needsSplit = new Set<string>();

  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false;

    // 1. clamp do bounds
    for (const p of clampToBounds(els, pageWidth, pageHeight, 3)) {
      const e = byId.get(p.id);
      if (!e) continue;
      if (p.x_mm !== undefined && Math.abs(e.x_mm - p.x_mm) > EPS) { e.x_mm = p.x_mm; changed = true; }
      if (p.y_mm !== undefined && Math.abs(e.y_mm - p.y_mm) > EPS) { e.y_mm = p.y_mm; changed = true; }
      if (p.w_mm !== undefined && Math.abs(e.w_mm - p.w_mm) > EPS) { e.w_mm = p.w_mm; changed = true; }
      if (p.h_mm !== undefined && Math.abs(e.h_mm - p.h_mm) > EPS) { e.h_mm = p.h_mm; changed = true; }
    }

    // 2. resolve overlap (text-text)
    const overlapEls = els.map((e) => ({
      id: e.id, type: e.type, x_mm: e.x_mm, y_mm: e.y_mm,
      w_mm: e.w_mm, h_mm: e.h_mm, z_index: e.z_index ?? 0,
    }));
    for (const p of resolveTextOverlaps(overlapEls, pageHeight, 3, 1.0)) {
      const e = byId.get(p.id);
      if (!e) continue;
      if (p.y_mm !== undefined && Math.abs(e.y_mm - p.y_mm) > EPS) { e.y_mm = p.y_mm; changed = true; }
      if (p.h_mm !== undefined && Math.abs(e.h_mm - p.h_mm) > EPS) { e.h_mm = p.h_mm; changed = true; }
    }

    // 3. shrink font do zmieszczenia (min 6pt) lub flag needs_split
    const shrinkEls = els.map((e) => ({
      id: e.id, type: e.type, w_mm: e.w_mm, h_mm: e.h_mm,
      properties: e.properties ?? {},
    }));
    for (const r of shrinkTextToFit(shrinkEls)) {
      const e = byId.get(r.id);
      if (!e) continue;
      if (r.needs_split) { needsSplit.add(r.id); continue; }
      if (r.font_size_pt !== undefined) {
        const cur = typeof e.properties?.font_size_pt === "number" ? e.properties.font_size_pt : 9;
        if (Math.abs(cur - r.font_size_pt) > EPS) {
          e.properties = { ...(e.properties ?? {}), font_size_pt: r.font_size_pt };
          changed = true;
        }
      }
    }

    if (!changed) break;
  }

  // Wyznacz zmienione id porównując z wejściem.
  const changedIds: string[] = [];
  for (const e of els) {
    const orig = input.find((o) => o.id === e.id);
    if (!orig) continue;
    const geomChanged =
      Math.abs((orig.x_mm ?? 0) - e.x_mm) > EPS ||
      Math.abs((orig.y_mm ?? 0) - e.y_mm) > EPS ||
      Math.abs((orig.w_mm ?? 0) - e.w_mm) > EPS ||
      Math.abs((orig.h_mm ?? 0) - e.h_mm) > EPS;
    const origFont = typeof orig.properties?.font_size_pt === "number" ? orig.properties.font_size_pt : undefined;
    const newFont = typeof e.properties?.font_size_pt === "number" ? e.properties.font_size_pt : undefined;
    const fontChanged = origFont !== newFont;
    if (geomChanged || fontChanged) changedIds.push(e.id);
  }

  return { elements: els, changedIds, needsSplit: Array.from(needsSplit) };
}
