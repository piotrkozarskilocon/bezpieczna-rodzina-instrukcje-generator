import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ pageId: string }>;
}

const VALID_TYPES = new Set([
  "text",
  "image",
  "line",
  "rect",
  "qr",
  "page_number",
  "callout",
]);

async function ownPage(
  sb: ReturnType<typeof getSupabaseAdmin>,
  pageId: string,
  email: string,
): Promise<boolean> {
  const { data: page } = await sb
    .from("gen4_pages")
    .select("project_id")
    .eq("id", pageId)
    .single();
  if (!page) return false;
  const { data: project } = await sb
    .from("gen4_projects")
    .select("owner_email")
    .eq("id", page.project_id)
    .single();
  return project?.owner_email === email;
}

export async function GET(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { pageId } = await ctx.params;
  const sb = getSupabaseAdmin();
  if (!(await ownPage(sb, pageId, auth.email)))
    return NextResponse.json({ error: "not found" }, { status: 404 });

  const { data, error } = await sb
    .from("gen4_elements")
    .select("id, type, x_mm, y_mm, w_mm, h_mm, z_index, rotation_deg, properties, created_at, updated_at")
    .eq("page_id", pageId)
    .order("z_index", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ elements: data ?? [] });
}

export async function POST(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { pageId } = await ctx.params;
  const sb = getSupabaseAdmin();
  if (!(await ownPage(sb, pageId, auth.email)))
    return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = (await request.json().catch(() => ({}))) as {
    type?: string;
    x_mm?: number;
    y_mm?: number;
    w_mm?: number;
    h_mm?: number;
    z_index?: number;
    rotation_deg?: number;
    properties?: Record<string, unknown>;
  };

  const type = typeof body.type === "string" ? body.type : null;
  if (!type || !VALID_TYPES.has(type)) {
    return NextResponse.json({ error: "invalid type" }, { status: 400 });
  }

  const insert = {
    page_id: pageId,
    type,
    x_mm: typeof body.x_mm === "number" ? body.x_mm : 5,
    y_mm: typeof body.y_mm === "number" ? body.y_mm : 5,
    w_mm: typeof body.w_mm === "number" ? body.w_mm : 30,
    h_mm: typeof body.h_mm === "number" ? body.h_mm : 5,
    z_index: typeof body.z_index === "number" ? body.z_index : 0,
    rotation_deg: typeof body.rotation_deg === "number" ? body.rotation_deg : 0,
    properties: body.properties ?? {},
  };

  const { data, error } = await sb
    .from("gen4_elements")
    .insert(insert)
    .select("*")
    .single();
  if (error || !data) return NextResponse.json({ error: error?.message ?? "insert failed" }, { status: 500 });
  return NextResponse.json({ element: data });
}
