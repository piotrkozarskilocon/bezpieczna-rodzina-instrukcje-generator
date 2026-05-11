import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const VALID_TEMPLATES = new Set([
  "blank",
  "cover",
  "step",
  "warranty_terms",
  "warranty_stamp",
  "contact",
]);

/** GET — list pages for a project (without elements; elements fetched separately). */
export async function GET(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const sb = getSupabaseAdmin();
  const { data: project, error: pErr } = await sb
    .from("gen3_projects")
    .select("id")
    .eq("id", id)
    .eq("owner_email", auth.email)
    .single();
  if (pErr || !project) return NextResponse.json({ error: "not found" }, { status: 404 });

  const { data: pages, error } = await sb
    .from("gen3_pages")
    .select("id, page_number, width_mm, height_mm, template, notes, created_at")
    .eq("project_id", id)
    .order("page_number", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ pages: pages ?? [] });
}

/**
 * POST — append a new page to the end of the project.
 * Body: { template?: string, width_mm?: number, height_mm?: number, notes?: string }
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const sb = getSupabaseAdmin();
  const { data: project, error: pErr } = await sb
    .from("gen3_projects")
    .select("id")
    .eq("id", id)
    .eq("owner_email", auth.email)
    .single();
  if (pErr || !project) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = (await request.json().catch(() => ({}))) as {
    template?: string;
    width_mm?: number;
    height_mm?: number;
    notes?: string;
  };

  const template =
    typeof body.template === "string" && VALID_TEMPLATES.has(body.template)
      ? body.template
      : "blank";
  const widthMm = typeof body.width_mm === "number" && body.width_mm > 0 ? body.width_mm : 76;
  const heightMm =
    typeof body.height_mm === "number" && body.height_mm > 0 ? body.height_mm : 76;

  // Determine next page_number.
  const { data: lastRows } = await sb
    .from("gen3_pages")
    .select("page_number")
    .eq("project_id", id)
    .order("page_number", { ascending: false })
    .limit(1);
  const nextNumber = (lastRows?.[0]?.page_number ?? 0) + 1;

  const { data: page, error } = await sb
    .from("gen3_pages")
    .insert({
      project_id: id,
      page_number: nextNumber,
      width_mm: widthMm,
      height_mm: heightMm,
      template,
      notes: typeof body.notes === "string" ? body.notes : null,
    })
    .select("id, page_number, width_mm, height_mm, template")
    .single();

  if (error || !page) {
    return NextResponse.json({ error: error?.message ?? "insert failed" }, { status: 500 });
  }
  return NextResponse.json({ page });
}
