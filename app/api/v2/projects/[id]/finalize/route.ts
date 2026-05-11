import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin, BUCKETS_V2 as BUCKETS } from "@/lib/supabase";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Called by the client after a successful direct upload to Supabase Storage.
 * Verifies the file exists in the bucket and commits source_pdf_path on the row.
 * If the upload didn't actually land, the project row is deleted to avoid
 * leaving zombie projects with no source PDF.
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const sb = getSupabaseAdmin();

  // Confirm caller owns the project.
  const { data: project, error: fetchErr } = await sb
    .from("gen2_projects")
    .select("id, owner_email")
    .eq("id", id)
    .eq("owner_email", auth.email)
    .single();

  if (fetchErr || !project) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const path = `${auth.email}/${id}/source.pdf`;

  // Verify the file actually landed.
  const dirPrefix = `${auth.email}/${id}`;
  const { data: files } = await sb.storage.from(BUCKETS.PDFS).list(dirPrefix);
  const found = files?.find((f) => f.name === "source.pdf");
  if (!found) {
    await sb.from("gen2_projects").delete().eq("id", id);
    return NextResponse.json({ error: "upload not found, project removed" }, { status: 410 });
  }

  await sb
    .from("gen2_projects")
    .update({ source_pdf_path: path })
    .eq("id", id);

  return NextResponse.json({ ok: true, path });
}
