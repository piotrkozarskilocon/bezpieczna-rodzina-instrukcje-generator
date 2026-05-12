import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { getAnthropicClient } from "@/lib/anthropic";

export const runtime = "nodejs";

const BUCKET = "gen4-reference-docs";

interface RouteContext {
  params: Promise<{ docId: string }>;
}

export async function DELETE(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { docId } = await ctx.params;
  const sb = getSupabaseAdmin();
  const { data: doc } = await sb
    .from("gen4_reference_docs")
    .select("id, project_id, file_path, anthropic_file_id")
    .eq("id", docId)
    .single();
  if (!doc) return NextResponse.json({ error: "not found" }, { status: 404 });

  const { data: project } = await sb
    .from("gen4_projects")
    .select("owner_email")
    .eq("id", doc.project_id)
    .single();
  if (project?.owner_email !== auth.email) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Storage delete (jeśli padnie, zostaje orphan, ale dla baz spójności
  // usuwamy też row).
  await sb.storage.from(BUCKET).remove([doc.file_path]);

  // Anthropic Files API delete — fire-and-forget, sukces nie jest krytyczny
  // (i tak auto-czyści po 90 dniach).
  if (doc.anthropic_file_id && process.env.ANTHROPIC_API_KEY) {
    try {
      const client = getAnthropicClient();
      await client.beta.files.delete(doc.anthropic_file_id);
    } catch {
      /* ignore */
    }
  }

  const { error } = await sb.from("gen4_reference_docs").delete().eq("id", docId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
