import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const maxDuration = 30;

interface RouteContext {
  params: Promise<{ id: string }>;
}

const BUCKET = "gen4-images";
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const ACCEPTED_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

async function ownProject(sb: ReturnType<typeof getSupabaseAdmin>, id: string, email: string): Promise<boolean> {
  const { data } = await sb.from("gen4_projects").select("owner_email").eq("id", id).single();
  return data?.owner_email === email;
}

/** Sign URL ważny 1h dla obrazka w prywatnym buckecie. */
async function signImageUrl(sb: ReturnType<typeof getSupabaseAdmin>, path: string): Promise<string | null> {
  const { data } = await sb.storage.from(BUCKET).createSignedUrl(path, 3600);
  return data?.signedUrl ?? null;
}

/** GET — lista obrazków projektu z signed URL-ami (do podglądu w UI). */
export async function GET(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const sb = getSupabaseAdmin();
  if (!(await ownProject(sb, id, auth.email))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const { data: images } = await sb
    .from("gen4_images")
    .select("id, name, path, size_bytes, width_px, height_px, description, preferred_page_id, mime_type, created_at")
    .eq("project_id", id)
    .order("created_at", { ascending: false });

  const withUrls = await Promise.all(
    (images ?? []).map(async (img) => ({
      ...img,
      url: await signImageUrl(sb, img.path),
    })),
  );
  return NextResponse.json({ images: withUrls });
}

/**
 * POST — upload obrazka. Multipart form-data:
 *   file: binarny obraz (PNG/JPG/WEBP/GIF, max 10 MB)
 *   description: krótki opis semantyczny (czego dotyczy obrazek)
 *   preferred_page_id?: uuid strony do której obrazek powinien preferencyjnie trafić
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const sb = getSupabaseAdmin();
  if (!(await ownProject(sb, id, auth.email))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "expected multipart/form-data" }, { status: 400 });
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "missing file field" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: `file too large (max ${MAX_BYTES / 1024 / 1024} MB)` }, { status: 413 });
  }
  if (!ACCEPTED_MIMES.has(file.type)) {
    return NextResponse.json({ error: `unsupported mime type: ${file.type}` }, { status: 415 });
  }

  const descriptionRaw = formData.get("description");
  const description = typeof descriptionRaw === "string" ? descriptionRaw.trim() : "";

  const preferredPageRaw = formData.get("preferred_page_id");
  const preferredPageId =
    typeof preferredPageRaw === "string" && preferredPageRaw.trim().length === 36
      ? preferredPageRaw.trim()
      : null;

  // Storage path: <project_id>/<timestamp>-<sanitized-name>
  const safeName = file.name.replace(/[^\w.\-]+/g, "_").slice(0, 80);
  const path = `${id}/${Date.now()}-${safeName}`;
  const buf = Buffer.from(await file.arrayBuffer());

  const { error: uploadErr } = await sb.storage
    .from(BUCKET)
    .upload(path, buf, { contentType: file.type, upsert: false });
  if (uploadErr) {
    return NextResponse.json({ error: `storage upload failed: ${uploadErr.message}` }, { status: 500 });
  }

  const { data: row, error: insertErr } = await sb
    .from("gen4_images")
    .insert({
      project_id: id,
      name: file.name.slice(0, 200),
      path,
      size_bytes: file.size,
      mime_type: file.type,
      description: description || null,
      preferred_page_id: preferredPageId,
      uploaded_by: auth.email,
    })
    .select("id, name, path, size_bytes, mime_type, description, preferred_page_id, created_at")
    .single();
  if (insertErr || !row) {
    // Cleanup: usuń plik z bucket żeby nie zostawić orphana.
    await sb.storage.from(BUCKET).remove([path]);
    return NextResponse.json({ error: insertErr?.message ?? "insert failed" }, { status: 500 });
  }

  const url = await signImageUrl(sb, row.path);
  return NextResponse.json({ image: { ...row, url } });
}
