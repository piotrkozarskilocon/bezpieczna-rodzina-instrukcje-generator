import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin, BUCKETS } from "@/lib/supabase";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from("generator_projects")
    .select("id, name, source_pdf_pages_count, source_pdf_path, created_at, updated_at")
    .eq("owner_email", auth.email)
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ projects: data ?? [] });
}

/**
 * Two-step PDF upload to bypass Vercel's 4.5 MB body limit:
 *   1. POST /api/projects with JSON { name, fileSize } → creates row + signed upload URL
 *   2. Client PUTs the file directly to Supabase Storage using the signed URL
 *   3. Client POSTs /api/projects/[id]/finalize to commit
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
  const fileSize = typeof body.fileSize === "number" ? body.fileSize : null;

  if (!name) return NextResponse.json({ error: "missing name" }, { status: 400 });
  if (fileSize == null || fileSize <= 0) {
    return NextResponse.json({ error: "missing fileSize" }, { status: 400 });
  }
  // Sanity cap: 100 MB. Adjust if real source PDFs exceed this.
  if (fileSize > 100 * 1024 * 1024) {
    return NextResponse.json({ error: "file too large (max 100 MB)" }, { status: 413 });
  }

  const sb = getSupabaseAdmin();

  const { data: project, error: insertErr } = await sb
    .from("generator_projects")
    .insert({
      owner_email: auth.email,
      name,
      source_pdf_size_bytes: fileSize,
    })
    .select("id")
    .single();

  if (insertErr || !project) {
    return NextResponse.json({ error: insertErr?.message ?? "insert failed" }, { status: 500 });
  }

  const path = `${auth.email}/${project.id}/source.pdf`;
  const { data: signed, error: signErr } = await sb.storage
    .from(BUCKETS.PDFS)
    .createSignedUploadUrl(path);

  if (signErr || !signed) {
    await sb.from("generator_projects").delete().eq("id", project.id);
    return NextResponse.json({ error: signErr?.message ?? "signed url failed" }, { status: 500 });
  }

  return NextResponse.json({
    id: project.id,
    path,
    uploadUrl: signed.signedUrl,
    token: signed.token,
  });
}
