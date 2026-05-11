import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin, BUCKETS_V3 } from "@/lib/supabase";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Called by the client after a successful direct upload of a reference PDF
 *  to Supabase Storage. Verifies the file exists and commits the path. */
export async function POST(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const sb = getSupabaseAdmin();

  const { data: project, error: fetchErr } = await sb
    .from("gen3_projects")
    .select("id, owner_email")
    .eq("id", id)
    .eq("owner_email", auth.email)
    .single();
  if (fetchErr || !project) return NextResponse.json({ error: "not found" }, { status: 404 });

  const path = `${auth.email}/${id}/reference.pdf`;
  const dirPrefix = `${auth.email}/${id}`;
  const { data: files } = await sb.storage.from(BUCKETS_V3.IMAGES).list(dirPrefix);
  const found = files?.find((f) => f.name === "reference.pdf");
  if (!found) {
    return NextResponse.json({ error: "upload not found" }, { status: 410 });
  }

  await sb
    .from("gen3_projects")
    .update({ reference_pdf_path: path })
    .eq("id", id);

  return NextResponse.json({ ok: true, path });
}
