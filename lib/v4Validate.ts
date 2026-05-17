/**
 * Algorytm walidacji layoutu strony — wykrywa problemy które AI lub user
 * mógł wprowadzić: tekst poza marginesami, overlap elementów, nieuczciwe
 * placeholdery DO UZUPEŁNIENIA, brak title, image bez image_id w bibliotece.
 *
 * Czysty server-side (nie wymaga DOM), żeby też endpoint lintingu mógł
 * z niego korzystać. Brak fetch'a — operuje na już załadowanych danych.
 */

const MM_PER_PT = 25.4 / 72;
const PAGE_MARGIN_MM = 3; // konwencja Locon — 3mm margines
const PLACEHOLDER_PATTERN = /⚠️\s*DO\s+UZUPE[ŁL]NIENIA/i;

export type IssueSeverity = "error" | "warning" | "info";

export interface ValidationIssue {
  severity: IssueSeverity;
  element_id?: string;
  element_type?: string;
  message: string;
  /** Sugerowana akcja naprawcza (do AI fix prompt). */
  fix_hint?: string;
  /** Czy "Napraw przez AI" powinien dotykać tego problemu. Domyślnie true
   *  dla wszystkich layoutowych issues (out-of-bounds, overflow, overlap,
   *  zerowe wymiary, brak title). FALSE dla placeholderów DO UZUPEŁNIENIA
   *  i image bez image_id — tych AI nie powinien wymyślać. */
  ai_fixable?: boolean;
}

export interface ElementForValidation {
  id: string;
  type: string;
  x_mm: number;
  y_mm: number;
  w_mm: number;
  h_mm: number;
  properties: Record<string, unknown>;
}

export interface PageForValidation {
  id: string;
  page_number: number;
  width_mm: number;
  height_mm: number;
  template: string | null;
  title: string | null;
  elements: ElementForValidation[];
}

/** Szacunkowa wysokość tekstu po word-wrap przy zadanej szerokości boxa.
 *  Używa heurystyki: średnia szerokość znaku ~0.5 × font_size, lineheight 1.2. */
function estimateTextHeight(content: string, fontSizePt: number, boxWidthMm: number): number {
  if (!content) return 0;
  // Szerokość boxa w "znakach" (heurystycznie).
  const avgCharWidthMm = (fontSizePt * 0.5) * MM_PER_PT;
  const charsPerLine = Math.max(1, Math.floor(boxWidthMm / avgCharWidthMm));
  // Linie z explicit \n + word-wrap na pozostałych.
  const paragraphs = content.split(/\r?\n/);
  let totalLines = 0;
  for (const p of paragraphs) {
    if (!p.trim()) { totalLines += 1; continue; }
    totalLines += Math.ceil(p.length / charsPerLine);
  }
  const lineHeightMm = fontSizePt * 1.2 * MM_PER_PT;
  return totalLines * lineHeightMm;
}

/** Sprawdza overlap dwóch bounding boxów (axis-aligned). */
function boxesOverlap(a: ElementForValidation, b: ElementForValidation): boolean {
  if (a.x_mm + a.w_mm <= b.x_mm) return false;
  if (b.x_mm + b.w_mm <= a.x_mm) return false;
  if (a.y_mm + a.h_mm <= b.y_mm) return false;
  if (b.y_mm + b.h_mm <= a.y_mm) return false;
  return true;
}

/** Główna funkcja walidacji — zwraca listę problemów dla pojedynczej strony. */
export function validatePage(page: PageForValidation): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // 1. Title — wymagany dla wszystkich poza cover
  if (page.template !== "cover" && !page.title?.trim()) {
    issues.push({
      severity: "warning",
      message: `Strona ${page.page_number} nie ma tytułu`,
      fix_hint: "Ustaw page.title — dodaj krótki nagłówek opisujący zawartość strony.",
      ai_fixable: false, // AI nie zna właściwego tytułu — user musi go zdefiniować
    });
  }

  for (const el of page.elements) {
    // 2. Out of page bounds (poza fizyczną stroną)
    if (el.x_mm < 0 || el.y_mm < 0 ||
        el.x_mm + el.w_mm > page.width_mm + 0.1 ||
        el.y_mm + el.h_mm > page.height_mm + 0.1) {
      issues.push({
        severity: "error",
        element_id: el.id,
        element_type: el.type,
        message: `Element ${el.type} wychodzi POZA stronę (pozycja: ${el.x_mm.toFixed(1)},${el.y_mm.toFixed(1)} ${el.w_mm.toFixed(1)}×${el.h_mm.toFixed(1)} mm; strona ${page.width_mm}×${page.height_mm} mm)`,
        fix_hint: `Przesuń element żeby mieścił się w obszarze strony (0,0)-(${page.width_mm},${page.height_mm}) mm.`,
        ai_fixable: true,
      });
    }

    // 3. Out of margin (poza 3mm marginesem)
    if (el.x_mm < PAGE_MARGIN_MM - 0.1 ||
        el.y_mm < PAGE_MARGIN_MM - 0.1 ||
        el.x_mm + el.w_mm > page.width_mm - PAGE_MARGIN_MM + 0.1 ||
        el.y_mm + el.h_mm > page.height_mm - PAGE_MARGIN_MM + 0.1) {
      issues.push({
        severity: "warning",
        element_id: el.id,
        element_type: el.type,
        message: `Element ${el.type} narusza ${PAGE_MARGIN_MM} mm margines strony`,
        fix_hint: `Przesuń element o kilka mm do wewnątrz — drukarnia obcina ${PAGE_MARGIN_MM} mm z każdej krawędzi.`,
        ai_fixable: true,
      });
    }

    // 4. Text overflow (treść za długa dla boxa)
    if (el.type === "text" || el.type === "callout") {
      const content = typeof el.properties.content === "string" ? el.properties.content : "";
      const fontSize = typeof el.properties.font_size_pt === "number" ? el.properties.font_size_pt : 9;
      if (content) {
        const estimatedH = estimateTextHeight(content, fontSize, el.w_mm - 1); // -1 mm na padding
        if (estimatedH > el.h_mm + 0.5) {
          issues.push({
            severity: "warning",
            element_id: el.id,
            element_type: el.type,
            message: `Tekst "${content.slice(0, 40)}${content.length > 40 ? "…" : ""}" jest za długi dla boxa (potrzeba ~${estimatedH.toFixed(1)} mm, jest ${el.h_mm.toFixed(1)} mm)`,
            fix_hint: `Powiększ h_mm boxa do ~${Math.ceil(estimatedH)} mm, lub zmniejsz font_size_pt, lub skróć treść.`,
            ai_fixable: true,
          });
        }
      }

      // 5. Placeholdery DO UZUPEŁNIENIA
      if (content && PLACEHOLDER_PATTERN.test(content)) {
        issues.push({
          severity: "info",
          element_id: el.id,
          element_type: el.type,
          message: `Element zawiera placeholder "⚠️ DO UZUPEŁNIENIA" — wartość niezdefiniowana`,
          fix_hint: "Wpisz konkretną wartość (z raportu SAR, specyfikacji technicznej itd.) lub wgraj plik referencyjny.",
          ai_fixable: false, // AI nie powinien wymyślać wartości — user musi je dostarczyć
        });
      }
    }

    // 6. Image bez image_id i bez placeholder_description
    if (el.type === "image") {
      const imageId = el.properties.image_id;
      const placeholderDesc = el.properties.placeholder_description;
      if (!imageId && !placeholderDesc) {
        issues.push({
          severity: "warning",
          element_id: el.id,
          element_type: el.type,
          message: "Element image bez image_id i bez opisu placeholderu",
          fix_hint: "Wgraj obrazek do biblioteki projektu z opisem i przypisz go preferred_page_id, lub usuń ten element.",
          ai_fixable: false, // AI nie wie który obrazek tu pasuje — user musi wgrać i przypisać
        });
      }
      // 6b. Image z opacity < 0.08 — prawie niewidoczny. AI czasem generuje
      //     opacity 0.03 myslac ze to "watermark", ale po naprawie rendera
      //     0.03 oznacza realnie niewidoczny obrazek. Watermark powinien byc
      //     w okolicy 0.10-0.20.
      const op = el.properties.opacity;
      if (typeof op === "number" && op > 0 && op < 0.08) {
        issues.push({
          severity: "info",
          element_id: el.id,
          element_type: el.type,
          message: `Image ma bardzo niską opacity (${op}) — prawie niewidoczny`,
          fix_hint: `Dla watermarka ustaw opacity 0.10–0.20 (obecnie ${op} daje praktycznie pusty box). Lub ustaw 0 żeby usunąć go z layoutu.`,
          ai_fixable: true,
        });
      }
    }

    // 7. Element z zerowymi wymiarami
    if (el.w_mm < 0.1 || el.h_mm < 0.1) {
      issues.push({
        severity: "warning",
        element_id: el.id,
        element_type: el.type,
        message: `Element ${el.type} ma zerowe wymiary (${el.w_mm}×${el.h_mm} mm) — może być niewidoczny`,
        ai_fixable: true,
      });
    }
  }

  // 8. Overlap między elementami (z wyłączeniem tła i page_number który zwykle nakłada się z tłem)
  const overlapPairs = new Set<string>();
  const textTypes = new Set(["text", "callout"]);
  for (let i = 0; i < page.elements.length; i++) {
    for (let j = i + 1; j < page.elements.length; j++) {
      const a = page.elements[i];
      const b = page.elements[j];
      // page_number, rect, line często celowo overlap z innymi — pomijamy
      const skipTypes = new Set(["rect", "line", "page_number"]);
      if (skipTypes.has(a.type) || skipTypes.has(b.type)) continue;
      if (!boxesOverlap(a, b)) continue;
      const key = [a.id, b.id].sort().join("|");
      if (overlapPairs.has(key)) continue;
      overlapPairs.add(key);
      // Text-text overlap to RZECZYWISTY BUG (czytelnosc zniszczona) — error
      // severity. Pozostale (np. image-text watermark) to info — moze byc celowe.
      const bothText = textTypes.has(a.type) && textTypes.has(b.type);
      issues.push({
        severity: bothText ? "error" : "info",
        element_id: a.id,
        element_type: a.type,
        message: `${a.type} nakłada się na ${b.type}${bothText ? " (NIECZYTELNE — bloki tekstu na sobie)" : " (sąsiednie boxy zachodzą)"}`,
        fix_hint: bothText
          ? `Uruchom dedupe-overlap (deterministyczny resolver ułoży pionowo) lub przesuń jeden z elementów (${a.type} ${a.id} albo ${b.type} ${b.id}).`
          : `Sprawdź czy to celowe — jeśli nie, przesuń jeden z elementów (${a.type} ${a.id} lub ${b.type} ${b.id}).`,
        ai_fixable: true,
      });
    }
  }

  return issues;
}

export interface ValidationSummary {
  errors: number;
  warnings: number;
  infos: number;
  total: number;
}

export function summarizeIssues(issues: ValidationIssue[]): ValidationSummary {
  let errors = 0, warnings = 0, infos = 0;
  for (const i of issues) {
    if (i.severity === "error") errors++;
    else if (i.severity === "warning") warnings++;
    else infos++;
  }
  return { errors, warnings, infos, total: issues.length };
}
