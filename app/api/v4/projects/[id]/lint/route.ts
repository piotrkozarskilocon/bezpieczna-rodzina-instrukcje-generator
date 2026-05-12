import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { validatePage, summarizeIssues, type ValidationIssue } from "@/lib/v4Validate";
import {
  getRequiredSections,
  isValidDocumentType,
  isValidDeviceType,
} from "@/lib/v4LegalTemplates";

export const runtime = "nodejs";
export const maxDuration = 30;

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Pre-export lint — sprawdza CAŁY projekt zanim user kliknie 'Pobierz PDF':
 *   1. Walidacja layoutu (z lib/v4Validate, per strona).
 *   2. Czy wszystkie required sections z legal templates są obecne (porównanie
 *      tytułów stron z oczekiwaną listą).
 *   3. Czy istnieją 'krytyczne placeholdery' w danych (info severity ze stron).
 *   4. Czy każde image_id w elementach faktycznie istnieje w bibliotece.
 * Zwraca breakdown per strona + lista missing sections + sumy.
 */
export async function GET(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const sb = getSupabaseAdmin();
  const { data: project } = await sb
    .from("gen4_projects")
    .select("id, owner_email, name, document_type, device_type, ai_input")
    .eq("id", id)
    .eq("owner_email", auth.email)
    .single();
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });

  const { data: pages } = await sb
    .from("gen4_pages")
    .select("id, page_number, width_mm, height_mm, template, title")
    .eq("project_id", id)
    .order("page_number", { ascending: true });
  if (!pages || pages.length === 0) {
    return NextResponse.json({
      issues_per_page: [],
      missing_sections: [],
      orphan_images: [],
      summary: { errors: 0, warnings: 0, infos: 0, total: 0 },
      total_pages: 0,
    });
  }

  const pageIds = pages.map((p) => p.id);
  const { data: elements } = await sb
    .from("gen4_elements")
    .select("id, page_id, type, x_mm, y_mm, w_mm, h_mm, properties")
    .in("page_id", pageIds);
  const byPage = new Map<string, typeof elements>();
  for (const el of elements ?? []) {
    const arr = byPage.get(el.page_id) ?? [];
    arr.push(el);
    byPage.set(el.page_id, arr);
  }

  // 1. Per-page walidacja
  const issuesPerPage: Array<{ page_number: number; page_title: string | null; issues: ValidationIssue[] }> = [];
  let totalErrors = 0, totalWarnings = 0, totalInfos = 0;
  for (const p of pages) {
    const pageIssues = validatePage({
      id: p.id,
      page_number: p.page_number,
      width_mm: p.width_mm,
      height_mm: p.height_mm,
      template: p.template,
      title: p.title,
      elements: (byPage.get(p.id) ?? []).map((e) => ({
        id: e.id,
        type: e.type,
        x_mm: e.x_mm,
        y_mm: e.y_mm,
        w_mm: e.w_mm,
        h_mm: e.h_mm,
        properties: e.properties as Record<string, unknown>,
      })),
    });
    if (pageIssues.length > 0) {
      issuesPerPage.push({ page_number: p.page_number, page_title: p.title, issues: pageIssues });
    }
    const s = summarizeIssues(pageIssues);
    totalErrors += s.errors;
    totalWarnings += s.warnings;
    totalInfos += s.infos;
  }

  // 2. Missing sections — porównaj tytuły stron z required sections
  const missingSections: Array<{ id: string; title: string; reason: string }> = [];
  const docType = project.document_type;
  const devType = project.device_type;
  if (isValidDocumentType(docType) && isValidDeviceType(devType)) {
    const stepCount =
      typeof (project.ai_input as Record<string, unknown>)?.step_count === "number"
        ? ((project.ai_input as Record<string, number>).step_count)
        : 1;
    const required = getRequiredSections(docType, devType, stepCount);
    const presentTitles = new Set(pages.map((p) => p.title?.toLowerCase() ?? ""));
    const presentTemplates = new Set(pages.map((p) => p.template ?? ""));
    for (const sec of required) {
      const titleMatch = sec.title.toLowerCase();
      const present =
        presentTitles.has(titleMatch) ||
        // Tytuły kroków AI ("Krok 1: Naładuj") rozpoczynają się od bazowego "Krok 1"
        Array.from(presentTitles).some((t) => t.startsWith(titleMatch));
      // Cover/toc — match po template
      const templateMatch =
        (sec.template === "cover" && presentTemplates.has("cover")) ||
        (sec.template === "toc" && presentTemplates.has("toc"));
      if (!present && !templateMatch) {
        missingSections.push({
          id: sec.id,
          title: sec.title,
          reason: sec.legal_basis
            ? `Wymagana sekcja (${sec.legal_basis})`
            : "Wymagana sekcja zgodnie z legal templates dla tego typu dokumentu/urządzenia",
        });
      }
    }
  }

  // 3. Orphan images — element ma image_id który nie istnieje w gen4_images
  const imageIdsInElements = new Set<string>();
  for (const el of elements ?? []) {
    if (el.type !== "image") continue;
    const id = (el.properties as Record<string, unknown> | null)?.image_id;
    if (typeof id === "string") imageIdsInElements.add(id);
  }
  const orphanImages: string[] = [];
  if (imageIdsInElements.size > 0) {
    const { data: existingImages } = await sb
      .from("gen4_images")
      .select("id")
      .in("id", Array.from(imageIdsInElements));
    const existingSet = new Set((existingImages ?? []).map((i) => i.id));
    for (const id of imageIdsInElements) {
      if (!existingSet.has(id)) orphanImages.push(id);
    }
  }

  return NextResponse.json({
    issues_per_page: issuesPerPage,
    missing_sections: missingSections,
    orphan_images: orphanImages,
    summary: {
      errors: totalErrors,
      warnings: totalWarnings,
      infos: totalInfos,
      total: totalErrors + totalWarnings + totalInfos,
    },
    total_pages: pages.length,
  });
}
