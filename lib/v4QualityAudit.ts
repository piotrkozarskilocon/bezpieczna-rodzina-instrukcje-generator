/**
 * Agregator jakości na poziomie PROJEKTU — łączy dwie osie akceptacji
 * dokumentu wynikowego (QSG/KG/IO):
 *
 *   1. LAYOUT  — czy wszystko mieści się na stronie i jest czytelne
 *                (reużywa per-stronowy validatePage z v4Validate).
 *   2. TREŚĆ   — czy dokument jest kompletny: brak placeholderów
 *                "DO UZUPEŁNIENIA" + jakie materiały źródłowe dały dane
 *                strukturalne (atrybucja kompletności).
 *
 * Czysty, bez fetch'a — operuje na już załadowanych danych, żeby był
 * testowalny i mógł być wołany przez route /quality-audit.
 */

import {
  validatePage,
  summarizeIssues,
  type PageForValidation,
  type ValidationIssue,
  type IssueCode,
} from "./v4Validate";

/** Kody należące do osi LAYOUT (dopasowanie do strony / czytelność). */
const LAYOUT_CODES: IssueCode[] = [
  "out_of_bounds",
  "margin_breach",
  "text_overflow",
  "tiny_font",
  "overlap_text",
  "overlap_other",
  "zero_dim",
];

export interface ReferenceDocForAudit {
  name: string;
  kind: string | null;
  hasStructured: boolean;
  hasSummary: boolean;
}

export interface ProjectForAudit {
  pages: PageForValidation[];
  referenceDocs: ReferenceDocForAudit[];
}

export interface PageAuditEntry {
  page_number: number;
  errors: number;
  warnings: number;
  infos: number;
  issues: ValidationIssue[];
}

export interface PlaceholderDetail {
  page_number: number;
  message: string;
}

export interface ProjectQualityReport {
  layout: {
    errors: number;
    warnings: number;
    infos: number;
    /** Liczność per kod layoutowy (każdy zainicjowany na 0). */
    byCode: Record<string, number>;
  };
  content: {
    placeholders: number;
    placeholderDetails: PlaceholderDetail[];
  };
  sources: {
    total: number;
    withStructured: number;
    withSummaryOnly: number;
    coveragePct: number;
    /** Dokumenty bez ekstrakcji strukturalnej — kandydaci do uzupełnienia. */
    missingStructured: { name: string; kind: string | null }[];
  };
  perPage: PageAuditEntry[];
  verdict: {
    ready: boolean;
    blockers: string[];
  };
}

export function auditProjectQuality(project: ProjectForAudit): ProjectQualityReport {
  const byCode: Record<string, number> = {};
  for (const c of LAYOUT_CODES) byCode[c] = 0;

  let layoutErrors = 0, layoutWarnings = 0, layoutInfos = 0;
  let placeholders = 0;
  const placeholderDetails: PlaceholderDetail[] = [];
  const perPage: PageAuditEntry[] = [];

  for (const page of project.pages) {
    const issues = validatePage(page);
    const summary = summarizeIssues(issues);
    perPage.push({
      page_number: page.page_number,
      errors: summary.errors,
      warnings: summary.warnings,
      infos: summary.infos,
      issues,
    });

    for (const issue of issues) {
      if (issue.code === "placeholder") {
        placeholders++;
        placeholderDetails.push({ page_number: page.page_number, message: issue.message });
        continue;
      }
      if (LAYOUT_CODES.includes(issue.code)) {
        byCode[issue.code]++;
        if (issue.severity === "error") layoutErrors++;
        else if (issue.severity === "warning") layoutWarnings++;
        else layoutInfos++;
      }
    }
  }

  const docs = project.referenceDocs;
  const withStructured = docs.filter((d) => d.hasStructured).length;
  const withSummaryOnly = docs.filter((d) => !d.hasStructured && d.hasSummary).length;
  const coveragePct = docs.length > 0 ? Math.round((100 * withStructured) / docs.length) : 100;
  const missingStructured = docs
    .filter((d) => !d.hasStructured)
    .map((d) => ({ name: d.name, kind: d.kind }));

  const blockers: string[] = [];
  if (layoutErrors > 0) {
    blockers.push(
      `${layoutErrors} błąd(ów) layoutu — elementy poza stroną lub nakładający się tekst (nieczytelne w druku)`,
    );
  }
  if (placeholders > 0) {
    blockers.push(
      `${placeholders} luk(a) treści — placeholdery "DO UZUPEŁNIENIA" wymagają wartości lub materiału źródłowego`,
    );
  }

  return {
    layout: { errors: layoutErrors, warnings: layoutWarnings, infos: layoutInfos, byCode },
    content: { placeholders, placeholderDetails },
    sources: { total: docs.length, withStructured, withSummaryOnly, coveragePct, missingStructured },
    perPage,
    verdict: { ready: blockers.length === 0, blockers },
  };
}
