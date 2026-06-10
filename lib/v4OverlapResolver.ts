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
    const n = sorted.length;
    const maxY = pageHeight - margin;
    const topY = Math.min(...sorted.map((s) => s.y_mm));
    const totalH = sorted.reduce((s, e) => s + e.h_mm, 0);
    const gapsTotal = gap * (n - 1);
    const totalNeeded = totalH + gapsTotal;

    // Punkt startowy: oryginalna górna krawędź grupy (faithful). Jeśli grupa nie
    // mieści się w dół do maxY, przesuń ją w GÓRĘ aż do marginesu — to zyskuje
    // miejsce ZANIM zaczniemy kompresować wysokości.
    let startY = Math.max(margin, topY);
    if (totalNeeded > maxY - startY) startY = Math.max(margin, maxY - totalNeeded);

    const available = maxY - startY;
    // Jeśli nawet po przesunięciu w górę grupa się nie mieści — kompresuj
    // wysokości PROPORCJONALNIE, żeby elementy NIE nachodziły na siebie.
    // Mniejsze h_mm może spowodować overflow tekstu — to naprawi fontShrinker
    // (font do 6pt) lub flag needs_split / auto-split. Priorytet: ZERO nakładań,
    // bo nakładający się tekst jest nieczytelny (gorsze niż ciasny układ).
    let scale = 1;
    if (totalNeeded > available) {
      scale = Math.max(0.05, (available - gapsTotal) / Math.max(0.1, totalH));
    }

    let cursorY = startY;
    for (const el of sorted) {
      const newH = +(el.h_mm * scale).toFixed(2);
      const newY = +cursorY.toFixed(2);
      const patch: OverlapPatch = {
        id: el.id,
        reason:
          scale < 1
            ? `dedupe-overlap: grupa ${n} elementów ułożona pionowo + kompresja h ×${scale.toFixed(2)} (strona ciasna — fontShrinker/split dopracuje)`
            : `dedupe-overlap: grupa ${n} elementów ułożona pionowo`,
      };
      if (Math.abs(el.y_mm - newY) > 0.05) patch.y_mm = newY;
      if (Math.abs(el.h_mm - newH) > 0.05) patch.h_mm = newH;
      if (patch.y_mm !== undefined || patch.h_mm !== undefined) patches.push(patch);
      cursorY += newH + gap;
    }
  }
  return patches;
}
