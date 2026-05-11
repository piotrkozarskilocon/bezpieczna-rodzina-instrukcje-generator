import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin, BUCKETS_V3 } from "@/lib/supabase";

export const runtime = "nodejs";

interface ProjectRow {
  id: string;
  name: string;
  default_lang: string;
  reference_pdf_path: string | null;
  reference_pdf_size_bytes: number | null;
  created_at: string;
  updated_at: string;
}

/** GET — list user's v3 projects, with page count derived from gen3_pages. */
export async function GET(request: NextRequest) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from("gen3_projects")
    .select("id, name, default_lang, reference_pdf_path, reference_pdf_size_bytes, created_at, updated_at")
    .eq("owner_email", auth.email)
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Page counts via grouped count.
  const projectIds = (data ?? []).map((p) => p.id);
  const pageCounts = new Map<string, number>();
  if (projectIds.length > 0) {
    const { data: pages } = await sb
      .from("gen3_pages")
      .select("project_id")
      .in("project_id", projectIds);
    for (const p of pages ?? []) {
      pageCounts.set(p.project_id, (pageCounts.get(p.project_id) ?? 0) + 1);
    }
  }

  return NextResponse.json({
    projects: (data ?? []).map((p: ProjectRow) => ({
      ...p,
      pages_count: pageCounts.get(p.id) ?? 0,
    })),
  });
}

/**
 * POST — create a new project. Reference PDF is optional.
 *
 * Body shapes:
 *   { name: string }                            → just creates the project
 *   { name: string, fileSize: number }          → also returns a signed
 *                                                 upload URL for a reference PDF
 *
 * Reference PDF is stored under gen3-images bucket at
 *   <email>/<projectId>/reference.pdf
 */
export async function POST(request: NextRequest) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { name?: string; fileSize?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const name = body.name?.trim();
  if (!name) return NextResponse.json({ error: "missing name" }, { status: 400 });
  const fileSize = typeof body.fileSize === "number" ? body.fileSize : null;
  if (fileSize != null && fileSize > 100 * 1024 * 1024) {
    return NextResponse.json({ error: "reference PDF too large (max 100 MB)" }, { status: 413 });
  }

  const sb = getSupabaseAdmin();

  const { data: project, error: insertErr } = await sb
    .from("gen3_projects")
    .insert({
      owner_email: auth.email,
      name,
      reference_pdf_size_bytes: fileSize,
    })
    .select("id")
    .single();

  if (insertErr || !project) {
    return NextResponse.json({ error: insertErr?.message ?? "insert failed" }, { status: 500 });
  }

  // No PDF requested → done.
  if (fileSize == null) {
    return NextResponse.json({ id: project.id, uploadUrl: null });
  }

  const path = `${auth.email}/${project.id}/reference.pdf`;
  const { data: signed, error: signErr } = await sb.storage
    .from(BUCKETS_V3.IMAGES)
    .createSignedUploadUrl(path);

  if (signErr || !signed) {
    await sb.from("gen3_projects").delete().eq("id", project.id);
    return NextResponse.json({ error: signErr?.message ?? "signed url failed" }, { status: 500 });
  }

  return NextResponse.json({
    id: project.id,
    path,
    uploadUrl: signed.signedUrl,
    token: signed.token,
  });
}
