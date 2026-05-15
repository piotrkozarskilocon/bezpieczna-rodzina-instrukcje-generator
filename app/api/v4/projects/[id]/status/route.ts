/**
 * Status overview projektu — agregowane statystyki dla UI.
 * GET /api/v4/projects/[id]/status
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const PLACEHOLDER_RE = /⚠️\s*DO\s+UZUPE[ŁL]NIENIA/i;
const BROKEN_SUMMARY_RE = /Nie widz|nie widz|Czekam na plik|I notice you|załączonego pliku|brak załączonego|brakuje załączonego|nie zobaczyłem|Plik zbyt duzy/i;

export async function GET(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id: projectId } = await ctx.params;
  const sb = getSupabaseAdmin();
  const { data: project } = await sb
    .from("gen4_projects")
    .select("owner_email, name, default_lang, document_type, device_type, created_at, updated_at")
    .eq("id", projectId)
    .single();
  if (!project || project.owner_email !== auth.email) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const [pagesRes, elementsRes, imagesRes, docsRes] = await Promise.all([
    sb.from("gen4_pages").select("id, template").eq("project_id", projectId),
    sb.from("gen4_elements").select("type, properties, page_id").in(
      "page_id",
      ((await sb.from("gen4_pages").select("id").eq("project_id", projectId)).data ?? []).map((p) => p.id),
    ),
    sb.from("gen4_images").select("id, preferred_page_id").eq("project_id", projectId),
    sb.from("gen4_reference_docs").select("id, kind, extracted_summary, extracted_structured").eq("project_id", projectId),
  ]);

  const pages = pagesRes.data ?? [];
  const elements = elementsRes.data ?? [];
  const images = imagesRes.data ?? [];
  const docs = docsRes.data ?? [];

  // Placeholder count
  let placeholders = 0;
  let imageMissingId = 0;
  for (const el of elements) {
    const props = el.properties as { content?: string; image_id?: string };
    if ((el.type === "text" || el.type === "callout") && typeof props?.content === "string") {
      if (PLACEHOLDER_RE.test(props.content)) placeholders++;
    }
    if (el.type === "image" && !props?.image_id) imageMissingId++;
  }

  const docsWithSummary = docs.filter((d) => d.extracted_summary && !BROKEN_SUMMARY_RE.test(d.extracted_summary)).length;
  const docsWithStructured = docs.filter((d) => d.extracted_structured).length;
  const imagesAssigned = images.filter((i) => i.preferred_page_id).length;

  return NextResponse.json({
    project: {
      name: project.name,
      default_lang: project.default_lang,
      document_type: project.document_type,
      device_type: project.device_type,
      created_at: project.created_at,
      updated_at: project.updated_at,
    },
    counts: {
      pages_total: pages.length,
      pages_cover: pages.filter((p) => p.template === "cover").length,
      pages_toc: pages.filter((p) => p.template === "toc").length,
      pages_content: pages.filter((p) => p.template !== "cover" && p.template !== "toc").length,
      elements_total: elements.length,
      images_total: images.length,
      images_assigned: imagesAssigned,
      images_unassigned: images.length - imagesAssigned,
      docs_total: docs.length,
      docs_with_summary: docsWithSummary,
      docs_with_structured: docsWithStructured,
    },
    issues: {
      text_placeholders: placeholders,
      image_missing_id: imageMissingId,
      total: placeholders + imageMissingId,
    },
    completeness: {
      // % to "production ready" feel
      summaries_pct: docs.length > 0 ? Math.round(100 * docsWithSummary / docs.length) : 100,
      structured_pct: docs.length > 0 ? Math.round(100 * docsWithStructured / docs.length) : 100,
      images_assigned_pct: images.length > 0 ? Math.round(100 * imagesAssigned / images.length) : 100,
      placeholders_filled_pct: placeholders > 0
        ? Math.round(100 * (pages.length - placeholders) / pages.length)
        : 100,
    },
  });
}
