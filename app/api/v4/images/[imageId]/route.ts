import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ imageId: string }>;
}

const BUCKET = "gen4-images";

/** Verify caller owns the project the image belongs to. */
async function ownImage(
  sb: ReturnType<typeof getSupabaseAdmin>,
  imageId: string,
  email: string,
): Promise<{ id: string; project_id: string; path: string } | null> {
  const { data: img } = await sb
    .from("gen4_images")
    .select("id, project_id, path")
    .eq("id", imageId)
    .single();
  if (!img) return null;
  const { data: pr } = await sb
    .from("gen4_projects")
    .select("owner_email")
    .eq("id", img.project_id)
    .single();
  return pr?.owner_email === email ? img : null;
}

export async function PATCH(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { imageId } = await ctx.params;
  const sb = getSupabaseAdmin();
  const owned = await ownImage(sb, imageId, auth.email);
  if (!owned) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = (await request.json().catch(() => ({}))) as {
    description?: string | null;
    preferred_page_id?: string | null;
    name?: string;
  };

  const update: Record<string, unknown> = {};
  if ("description" in body) {
    update.description =
      typeof body.description === "string" && body.description.trim()
        ? body.description.trim()
        : null;
  }
  if ("preferred_page_id" in body) {
    update.preferred_page_id =
      typeof body.preferred_page_id === "string" && body.preferred_page_id.length === 36
        ? body.preferred_page_id
        : null;
  }
  if (typeof body.name === "string" && body.name.trim()) {
    update.name = body.name.trim().slice(0, 200);
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }

  const { error } = await sb.from("gen4_images").update(update).eq("id", imageId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { imageId } = await ctx.params;
  const sb = getSupabaseAdmin();
  const owned = await ownImage(sb, imageId, auth.email);
  if (!owned) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Storage first → row second. Jeśli storage padnie a row by został,
  // user może retry. Jeśli row padnie po storage delete — orphan w bazie,
  // nieszkodliwy.
  await sb.storage.from(BUCKET).remove([owned.path]);
  const { error } = await sb.from("gen4_images").delete().eq("id", imageId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
