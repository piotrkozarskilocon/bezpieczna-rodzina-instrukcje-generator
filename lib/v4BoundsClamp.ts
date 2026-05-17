/**
 * Deterministyczny clamp elementów do bounds strony.
 *
 * Problem: AI auto-populate/regenerate/apply-design czasem zwraca elementy
 * które wystają poza marginesy strony (y_mm + h_mm > pageHeight - margin,
 * x_mm + w_mm > pageWidth - margin). User: "Odgórny nakaz, to brak
 * wychodzenia poza strony, bo to nadal jest problem."
 *
 * Rozwiązanie deterministyczne (bez AI):
 *  1. Per element sprawdź czy mieści się w bounds (x_mm/y_mm/w_mm/h_mm vs pageW/pageH).
 *  2. Jeśli x_mm < margin → przesuń element na margin, skróć w_mm.
 *  3. Jeśli x_mm + w_mm > pageWidth - margin → skróć w_mm.
 *  4. Jeśli y_mm < margin → przesuń element na margin, skróć h_mm.
 *  5. Jeśli y_mm + h_mm > pageHeight - margin → skróć h_mm.
 *  6. Jeśli element ma h_mm/w_mm < 4 po clampie → flag jako "too_small"
 *     (zostawia w bazie, ale UI/AI może zaproponować usunięcie albo split).
 *
 * NIE dotyka properties (content/font_size_pt) — tylko geometry. Skracanie
 * h_mm może spowodować truncation tekstu — to OK, lepiej truncate niż wystawać.
 * Trwałe rozwiązanie (split na 2 strony) wymaga AI — tu robimy bezpieczny fallback.
 *
 * Funkcja pure — zwraca patches dla elementów które wymagają zmiany.
 */

export interface ClampElement {
  id: string;
  type: string;
  x_mm: number;
  y_mm: number;
  w_mm: number;
  h_mm: number;
}

export interface ClampPatch {
  id: string;
  x_mm?: number;
  y_mm?: number;
  w_mm?: number;
  h_mm?: number;
  /** Czy po clampie wymiary są zbyt małe (<4 mm) — sygnalizuje że treść się nie zmieści. */
  too_small?: boolean;
  reason: string;
}

const MIN_DIMENSION_MM = 4;

export function clampToBounds(
  elements: ClampElement[],
  pageWidth: number,
  pageHeight: number,
  margin = 3,
): ClampPatch[] {
  const patches: ClampPatch[] = [];
  const minX = margin;
  const maxX = pageWidth - margin;
  const minY = margin;
  const maxY = pageHeight - margin;

  for (const el of elements) {
    let newX = el.x_mm;
    let newY = el.y_mm;
    let newW = el.w_mm;
    let newH = el.h_mm;
    const reasons: string[] = [];

    // 1. Lewa krawędź poza marginesem
    if (el.x_mm < minX) {
      const shift = minX - el.x_mm;
      newX = minX;
      newW = Math.max(MIN_DIMENSION_MM, el.w_mm - shift);
      reasons.push(`x<${minX}`);
    }
    // 2. Prawa krawędź poza marginesem
    if (newX + newW > maxX) {
      newW = Math.max(MIN_DIMENSION_MM, maxX - newX);
      reasons.push(`x+w>${maxX}`);
    }
    // 3. Górna krawędź poza marginesem
    if (el.y_mm < minY) {
      const shift = minY - el.y_mm;
      newY = minY;
      newH = Math.max(MIN_DIMENSION_MM, el.h_mm - shift);
      reasons.push(`y<${minY}`);
    }
    // 4. Dolna krawędź poza marginesem
    if (newY + newH > maxY) {
      newH = Math.max(MIN_DIMENSION_MM, maxY - newY);
      reasons.push(`y+h>${maxY}`);
    }

    if (reasons.length === 0) continue;

    const patch: ClampPatch = {
      id: el.id,
      reason: `clamp-to-bounds: ${reasons.join(", ")}`,
    };
    if (Math.abs(newX - el.x_mm) > 0.05) patch.x_mm = +newX.toFixed(2);
    if (Math.abs(newY - el.y_mm) > 0.05) patch.y_mm = +newY.toFixed(2);
    if (Math.abs(newW - el.w_mm) > 0.05) patch.w_mm = +newW.toFixed(2);
    if (Math.abs(newH - el.h_mm) > 0.05) patch.h_mm = +newH.toFixed(2);

    // Flag too_small jeśli po clampie wymiary są na granicy minimum.
    // To sygnał że treść elementu prawdopodobnie się nie zmieści w obrazie
    // — wymagałby split strony lub zmniejszenia fontu (poza zakresem clampa).
    if (newW <= MIN_DIMENSION_MM + 0.1 || newH <= MIN_DIMENSION_MM + 0.1) {
      patch.too_small = true;
    }

    patches.push(patch);
  }

  return patches;
}

/** Czy strona ma JAKIKOLWIEK element wystający poza bounds (pre-check, bez aplikacji). */
export function hasOutOfBoundsElements(
  elements: ClampElement[],
  pageWidth: number,
  pageHeight: number,
  margin = 3,
): boolean {
  const minX = margin;
  const maxX = pageWidth - margin;
  const minY = margin;
  const maxY = pageHeight - margin;
  for (const el of elements) {
    if (el.x_mm < minX - 0.05) return true;
    if (el.y_mm < minY - 0.05) return true;
    if (el.x_mm + el.w_mm > maxX + 0.05) return true;
    if (el.y_mm + el.h_mm > maxY + 0.05) return true;
  }
  return false;
}
