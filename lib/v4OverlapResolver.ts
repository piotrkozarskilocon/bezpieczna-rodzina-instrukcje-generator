/**
 * Deterministyczny resolver overlap tekstowych elementów na stronie.
 *
 * Problem: AI auto-populate / regenerate / apply-design często wstawia 2-3
 * nakładające się text/callout boxy na te same koordynaty. Manualny ai-edit
 * z fix_hint nie zawsze rozwiązuje (AI nie wie którą stronę przesunąć).
 *
 * Rozwiązanie: matematyczne — grupuj nakładające teksty, ułóż je pionowo
 * jeden pod drugim z 1mm gap, zachowując oryginalne wysokości (lub skróć
 * gdy nie mieszczą się do końca strony minus margin).
 *
 * Działanie:
 *  1. Bierze tylko text + callout (rect/line/page_number/qr/image pomija)
 *  2. Grupuje pary które się nakładają (transitive — A∩B, B∩C → grupa [A,B,C])
 *  3. Per grupa: sortuj wg z_index potem y_mm, układaj pionowo od najwyższego y_mm
 *  4. Gdy nie mieści się: skróć h_mm. Gdy nawet po skróceniu nie wpada — zostaw
 *     na końcu strony (best-effort), niech user widzi i decyduje czy usunąć.
 *
 * Funkcja jest pure — nie modyfikuje wejścia, zwraca nową listę z Partial
 * patches per element (tylko te które się zmieniły).
 */

export interface OverlapElement {
  id: string;
  type: string;
  x_mm: number;
  y_mm: number;
  w_mm: number;
  h_mm: number;
  z_index: number | null;
}

export interface OverlapPatch {
  id: string;
  y_mm?: number;
  h_mm?: number;
  /** Diagnostyka — co się zmieniło i dlaczego. */
  reason: string;
}

const TEXT_TYPES = new Set(["text", "callout"]);

function boxesOverlap(a: OverlapElement, b: OverlapElement): boolean {
  if (a.x_mm + a.w_mm <= b.x_mm) return false;
  if (b.x_mm + b.w_mm <= a.x_mm) return false;
  if (a.y_mm + a.h_mm <= b.y_mm) return false;
  if (b.y_mm + b.h_mm <= a.y_mm) return false;
  return true;
}

/** Czy poziomo nakładają się (potrzebne żeby decydować że overlap jest poważny —
 *  jeśli horyzontalnie nie nachodzą, to overlap jest tylko vertical i można
 *  rozwiązać układając side-by-side… ale dla bezpieczeństwa traktujemy każdy
 *  overlap text-text jako problem do rozwiązania pionowo). */

export function findOverlapGroups(elements: OverlapElement[]): OverlapElement[][] {
  const textEls = elements.filter((e) => TEXT_TYPES.has(e.type));
  const assigned = new Set<string>();
  const groups: OverlapElement[][] = [];

  for (const a of textEls) {
    if (assigned.has(a.id)) continue;
    // BFS — rozszerzaj grupę o wszystkie tranzytywnie nakładające
    const group: OverlapElement[] = [a];
    assigned.add(a.id);
    let changed = true;
    while (changed) {
      changed = false;
      for (const b of textEls) {
        if (assigned.has(b.id)) continue;
        if (group.some((g) => boxesOverlap(g, b))) {
          group.push(b);
          assigned.add(b.id);
          changed = true;
        }
      }
    }
    if (group.length > 1) groups.push(group);
  }
  return groups;
}

/** Główna funkcja — zwraca patches dla elementów które trzeba przesunąć.
 *  pageHeight + margin definiują maksymalny y_mm + h_mm do którego można układać.
 *  gap = odstęp między elementami w mm (1.0 = ciasno ale czytelnie). */
export function resolveTextOverlaps(
  elements: OverlapElement[],
  pageHeight: number,
  margin = 3,
  gap = 1.0,
): OverlapPatch[] {
  const patches: OverlapPatch[] = [];
  const groups = findOverlapGroups(elements);

  for (const group of groups) {
    // Sortuj wg z_index (niższy = pod spodem) potem y_mm (wyższy = wcześniej w grupie)
    const sorted = [...group].sort((a, b) => {
      const za = a.z_index ?? 0;
      const zb = b.z_index ?? 0;
      if (za !== zb) return za - zb;
      return a.y_mm - b.y_mm;
    });
    // Start od najwyższego y_mm w grupie — szanujemy oryginalne położenie wejścia
    const topY = Math.min(...sorted.map((s) => s.y_mm));
    const maxY = pageHeight - margin;
    let cursorY = Math.max(topY, margin);

    for (const el of sorted) {
      const remainingSpace = maxY - cursorY;
      if (remainingSpace <= 0) {
        // Nie ma juz miejsca w stronie — to nie znaczy że element jest "niemożliwy".
        // Zostaw go z oryginalnymi wymiarami w pozycji minimum-margin-bottom; auto-split
        // potem zauważy że strona ma overflow i podzieli ją na 2. Lub fontShrinker
        // zmniejszy font dla wszystkich elementów strony żeby się zmieściły.
        // NIE skracaj do 4mm bo to ukrywa tekst — lepiej zostawić widoczny problem
        // który następna warstwa naprawi.
        patches.push({
          id: el.id,
          y_mm: Math.max(margin, maxY - el.h_mm),
          reason: `overflow: brak miejsca po ułożeniu grupy ${group.length} elementów — strona wymaga splitu lub mniejszego fontu`,
        });
        continue;
      }
      const targetH = Math.min(el.h_mm, remainingSpace);
      const patch: OverlapPatch = { id: el.id, reason: `dedupe-overlap: grupa ${group.length} elementów ułożona pionowo` };
      if (Math.abs(el.y_mm - cursorY) > 0.05) patch.y_mm = +cursorY.toFixed(2);
      if (Math.abs(el.h_mm - targetH) > 0.05) patch.h_mm = +targetH.toFixed(2);
      if (patch.y_mm !== undefined || patch.h_mm !== undefined) {
        patches.push(patch);
      }
      cursorY += targetH + gap;
    }
  }
  return patches;
}
