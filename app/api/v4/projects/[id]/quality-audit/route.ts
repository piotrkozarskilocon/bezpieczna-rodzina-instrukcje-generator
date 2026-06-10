import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { auditProjectQuality, type ReferenceDocForAudit } from "@/lib/v4QualityAudit";
import type { PageForValidation } from "@/lib/v4Validate";

export const runtime = "nodejs";
export const maxDuration = 30;

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Brama jakości na poziomie projektu — jeden werdykt łączący dwie osie
 * akceptacji dokumentu wynikowego:
 *   • LAYOUT — czy wszystko mieści się na stronie i jest czytelne (font ≥6pt,
 *     brak elementów poza stroną, brak nakładania tekstu).
 *   • TREŚĆ  — kompletność: placeholdery "DO UZUPEŁNIENIA" + pokrycie ekstrakcji
 *     strukturalnej z materiałów źródłowych (atrybucja, czego brakuje).
 *
 * Komplementarny do /lint (sekcje prawne + orphan images). Cienki adapter —
 * cała logika w lib/v4QualityAudit (czysta, testowana).
 */
export async function GET(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const sb = getSupabaseAdmin();

  const { data: project } = await sb
    .from("gen4_projects")
    .select("id, owner_email")
    .eq("id", id)
    .eq("owner_email", auth.email)
    .single();
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });

  const { data: pages } = await sb
    .from("gen4_pages")
    .select("id, page_number, width_mm, height_mm, template, title")
    .eq("project_id", id)
    .order("page_number", { ascending: true });

  const pageList = pages ?? [];
  const pageIds = pageList.map((p) => p.id);

  const { data: elements } = pageIds.length
    ? await sb
        .from("gen4_elements")
        .select("id, page_id, type, x_mm, y_mm, w_mm, h_mm, properties")
        .in("page_id", pageIds)
    : { data: [] as Array<Record<string, unknown>> };

  const byPage = new Map<string, PageForValidation["elements"]>();
  for (const el of (elements ?? []) as Array<Record<string, unknown>>) {
    const pid = el.page_id as string;
    const arr = byPage.get(pid) ?? [];
    arr.push({
      id: el.id as string,
      type: el.type as string,
      x_mm: el.x_mm as number,
      y_mm: el.y_mm as number,
      w_mm: el.w_mm as number,
      h_mm: el.h_mm as number,
      properties: (el.properties ?? {}) as Record<string, unknown>,
    });
    byPage.set(pid, arr);
  }

  const auditPages: PageForValidation[] = pageList.map((p) => ({
    id: p.id,
    page_number: p.page_number,
    width_mm: p.width_mm,
    height_mm: p.height_mm,
    template: p.template,
    title: p.title,
    elements: byPage.get(p.id) ?? [],
  }));

  const { data: docs } = await sb
    .from("gen4_reference_docs")
    .select("name, kind, extracted_summary, extracted_structured")
    .eq("project_id", id);

  const referenceDocs: ReferenceDocForAudit[] = (docs ?? []).map((d) => {
    const structured = d.extracted_structured as unknown;
    const hasStructured =
      structured != null &&
      typeof structured === "object" &&
      Object.keys(structured as Record<string, unknown>).length > 0;
    return {
      name: (d.name as string) ?? "(bez nazwy)",
      kind: (d.kind as string) ?? null,
      hasStructured,
      hasSummary: Boolean(d.extracted_summary),
    };
  });

  const report = auditProjectQuality({ pages: auditPages, referenceDocs });
  return NextResponse.json(report);
}
