import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin, BUCKETS } from "@/lib/supabase";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Returns a short-lived signed download URL for the project's source PDF. */
export async function GET(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const sb = getSupabaseAdmin();

  const { data: project, error } = await sb
    .from("generator_projects")
    .select("source_pdf_path")
    .eq("id", id)
    .eq("owner_email", auth.email)
    .single();

  if (error || !project?.source_pdf_path) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const { data: signed, error: signErr } = await sb.storage
    .from(BUCKETS.PDFS)
    .createSignedUrl(project.source_pdf_path, 60 * 60); // 1 hour

  if (signErr || !signed) {
    return NextResponse.json({ error: signErr?.message ?? "sign failed" }, { status: 500 });
  }

  return NextResponse.json({ url: signed.signedUrl });
}
