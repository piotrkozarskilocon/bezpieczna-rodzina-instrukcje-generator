/**
 * Smart font shrinker — gdy tekst nie mieści się w boxie, zmniejsz font_size_pt
 * tak żeby się zmieścił. To LEPSZE niż skracać h_mm do minimum (=tekst znika)
 * lub zostawić overflow (=tekst się ucina).
 *
 * User: "nie ma czegoś takiego jak tekst niemożliwy do zmieszczenia! albo pole
 * tekstowe jest za małe, albo czcionka za duża, albo pole tekstowe jest źle
 * ustawione, albo należy zawartość podzielić na więcej stron".
 *
 * Strategia kaskadowa:
 *  1. Sprawdź czy tekst mieści się w obecnym boxie z obecnym fontem.
 *  2. Jeśli nie — zmniejsz font (krok 0.5pt) aż się zmieści, min 6pt.
 *  3. Jeśli nawet 6pt nie wystarczy — flag needs_split (do AI auto-split).
 *
 * Estimacja jest heurystyczna (jak v4Validate.estimateTextHeight) — wystarczająco
 * dokładna dla decyzji "wzmiesci sie / nie". Faktyczne PDF rendering uzywa fontkit
 * z wlasciwymi metrykami, ale to jest na koncowym etapie eksportu.
 */

const MM_PER_PT = 0.3527;
const LINE_HEIGHT_FACTOR = 1.2;
const MIN_FONT_PT = 6;
/** Średnia szerokość znaku jako fraction pt (heurystyka — proporcjonalny font).
 *  ~0.5 dla Inter Regular w łaicach łacińskich. */
const CHAR_WIDTH_FRACTION = 0.5;

export interface ShrinkElement {
  id: string;
  type: string;
  w_mm: number;
  h_mm: number;
  properties: {
    content?: string;
    font_size_pt?: number;
    [k: string]: unknown;
  };
}

export interface ShrinkResult {
  id: string;
  /** Nowa wartość font_size_pt (gdy shrink wystarczyl). */
  font_size_pt?: number;
  /** Tekst nie miesci sie nawet przy min font — wymaga splitu lub wiekszego pola. */
  needs_split?: boolean;
  reason: string;
}

function estimateLinesForWidth(content: string, fontPt: number, widthMm: number): number {
  const charWidthMm = fontPt * CHAR_WIDTH_FRACTION * MM_PER_PT;
  if (charWidthMm <= 0 || widthMm <= 0) return 1;
  const charsPerLine = Math.max(1, Math.floor(widthMm / charWidthMm));
  const paragraphs = content.split("\n");
  let lines = 0;
  for (const p of paragraphs) {
    if (!p.trim()) {
      lines += 1;
      continue;
    }
    lines += Math.ceil(p.length / charsPerLine);
  }
  return Math.max(1, lines);
}

export function estimateTextHeightMm(content: string, fontPt: number, widthMm: number): number {
  const lines = estimateLinesForWidth(content, fontPt, widthMm);
  return lines * fontPt * LINE_HEIGHT_FACTOR * MM_PER_PT;
}

/** Główna funkcja — zwraca patches dla elementów których font trzeba zmniejszyć.
 *  Lub flag `needs_split` gdy nawet min font nie wystarczy. */
export function shrinkTextToFit(elements: ShrinkElement[]): ShrinkResult[] {
  const results: ShrinkResult[] = [];
  for (const el of elements) {
    if (el.type !== "text" && el.type !== "callout") continue;
    const content = typeof el.properties?.content === "string" ? el.properties.content : "";
    const currentFont = typeof el.properties?.font_size_pt === "number" ? el.properties.font_size_pt : 9;
    if (!content || !content.trim()) continue;
    if (el.w_mm <= 0 || el.h_mm <= 0) continue;

    // Estimacja szerokości "wolnej" dla tekstu — odejmij ~1mm padding zostawiony przez renderer.
    const usableW = Math.max(1, el.w_mm - 1);

    const estimatedH = estimateTextHeightMm(content, currentFont, usableW);
    if (estimatedH <= el.h_mm + 0.5) continue; // mieści się, nic nie rób

    // Spróbuj zmniejszyć font krokami 0.5pt aż się zmieści.
    let foundFont: number | null = null;
    for (let pt = currentFont - 0.5; pt >= MIN_FONT_PT; pt -= 0.5) {
      const h = estimateTextHeightMm(content, pt, usableW);
      if (h <= el.h_mm + 0.5) {
        foundFont = +pt.toFixed(1);
        break;
      }
    }

    if (foundFont !== null) {
      results.push({
        id: el.id,
        font_size_pt: foundFont,
        reason: `shrink-font: ${currentFont}pt → ${foundFont}pt (tekst ${content.length} znaków, box ${el.w_mm}×${el.h_mm} mm)`,
      });
    } else {
      results.push({
        id: el.id,
        needs_split: true,
        reason: `tekst nie mieści się nawet przy ${MIN_FONT_PT}pt — wymaga splitu strony lub większego pola (${content.length} znaków, box ${el.w_mm}×${el.h_mm} mm)`,
      });
    }
  }
  return results;
}

/** Pomocnicze — czy jakikolwiek element w grupie ma needs_split. */
export function hasNeedsSplit(results: ShrinkResult[]): boolean {
  return results.some((r) => r.needs_split === true);
}
