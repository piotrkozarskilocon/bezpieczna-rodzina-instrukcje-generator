import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const BUCKET = "gen4-reference-docs";
const MAX_BYTES = 25 * 1024 * 1024; // 25 MB — limit Anthropic Files API

/** Zwraca signed upload URL dla direct upload do Supabase Storage (omija Vercel,
 *  który ma 4.5 MB cap na body multipart). Frontend uploaduje PUT-em prosto
 *  do bucket, potem wywołuje POST /reference-docs z file_path. */
export async function POST(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const sb = getSupabaseAdmin();
  const { data: project } = await sb
    .from("gen4_projects")
    .select("owner_email")
    .eq("id", id)
    .single();
  if (project?.owner_email !== auth.email) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const body = (await request.json().catch(() => null)) as
    | { filename?: string; size_bytes?: number }
    | null;
  const filename = body?.filename?.trim();
  if (!filename) return NextResponse.json({ error: "missing filename" }, { status: 400 });
  if (typeof body?.size_bytes === "number" && body.size_bytes > MAX_BYTES) {
    return NextResponse.json({ error: `file too large (max 25 MB)` }, { status: 413 });
  }

  const safeName = filename.replace(/[^\w.\-]+/g, "_").slice(0, 100);
  const path = `${id}/${Date.now()}-${safeName}`;

  const { data, error } = await sb.storage.from(BUCKET).createSignedUploadUrl(path);
  if (error || !data) {
    return NextResponse.json({ error: error?.message ?? "signed url failed" }, { status: 500 });
  }

  return NextResponse.json({
    file_path: path,
    signed_url: data.signedUrl,
    token: data.token,
  });
}
