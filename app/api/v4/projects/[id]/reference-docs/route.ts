import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { getAnthropicClient, callClaude, EDIT_MODEL } from "@/lib/anthropic";
import { toFile } from "@anthropic-ai/sdk/core/uploads";

export const runtime = "nodejs";
export const maxDuration = 90;

const BUCKET = "gen4-reference-docs";
const MAX_BYTES = 25 * 1024 * 1024; // 25 MB — limit Anthropic Files API
const VALID_KINDS = new Set(["sar_report", "tech_spec", "manufacturer_manual", "declaration_ce", "other"]);

interface RouteContext {
  params: Promise<{ id: string }>;
}

async function ownProject(sb: ReturnType<typeof getSupabaseAdmin>, id: string, email: string): Promise<boolean> {
  const { data } = await sb.from("gen4_projects").select("owner_email").eq("id", id).single();
  return data?.owner_email === email;
}

/** GET — lista plików referencyjnych projektu z signed URL do pobrania. */
export async function GET(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const sb = getSupabaseAdmin();
  if (!(await ownProject(sb, id, auth.email))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { data: docs } = await sb
    .from("gen4_reference_docs")
    .select("id, kind, source_lang, name, file_path, size_bytes, mime_type, anthropic_file_id, extracted_summary, created_at")
    .eq("project_id", id)
    .order("created_at", { ascending: false });

  const enriched = await Promise.all(
    (docs ?? []).map(async (d) => {
      const { data: signed } = await sb.storage.from(BUCKET).createSignedUrl(d.file_path, 3600);
      return { ...d, download_url: signed?.signedUrl ?? null };
    }),
  );
  return NextResponse.json({ docs: enriched });
}

/**
 * POST — upload pliku referencyjnego (multipart).
 *   file: PDF, max 25 MB
 *   kind: sar_report | tech_spec | manufacturer_manual | declaration_ce | other
 *   source_lang: pl/en/zh/etc (domyślnie pl)
 *
 * Plan po stronie serwera:
 *   1. Walidacja + upload do Supabase Storage (bucket gen4-reference-docs).
 *   2. Insert wiersza w gen4_reference_docs (bez anthropic_file_id).
 *   3. Jeśli ANTHROPIC_API_KEY skonfigurowany — upload tego samego pliku do
 *      Anthropic Files API i zapis anthropic_file_id. Fire-and-forget extract
 *      summary (~5-10s) — user dostaje response gdy plik jest już w storage.
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
    return NextResponse.json({ error: `file too large (max 25 MB)` }, { status: 413 });
  }
  if (file.type !== "application/pdf") {
    return NextResponse.json({ error: "tylko PDF jest obsługiwany w fazie 1" }, { status: 415 });
  }
  const kindRaw = formData.get("kind");
  const kind = typeof kindRaw === "string" && VALID_KINDS.has(kindRaw) ? kindRaw : "other";
  const sourceLang = (formData.get("source_lang") as string | null)?.toLowerCase()?.slice(0, 5) ?? "pl";

  // 1. Storage upload
  const safeName = file.name.replace(/[^\w.\-]+/g, "_").slice(0, 100);
  const filePath = `${id}/${Date.now()}-${safeName}`;
  const buf = Buffer.from(await file.arrayBuffer());
  const { error: uploadErr } = await sb.storage
    .from(BUCKET)
    .upload(filePath, buf, { contentType: file.type, upsert: false });
  if (uploadErr) {
    return NextResponse.json({ error: `storage upload failed: ${uploadErr.message}` }, { status: 500 });
  }

  // 2. Insert row
  const { data: row, error: insertErr } = await sb
    .from("gen4_reference_docs")
    .insert({
      project_id: id,
      kind,
      source_lang: sourceLang,
      name: file.name.slice(0, 200),
      file_path: filePath,
      size_bytes: file.size,
      mime_type: file.type,
      uploaded_by: auth.email,
    })
    .select("id, kind, source_lang, name, file_path, size_bytes, mime_type, created_at")
    .single();
  if (insertErr || !row) {
    await sb.storage.from(BUCKET).remove([filePath]);
    return NextResponse.json({ error: insertErr?.message ?? "insert failed" }, { status: 500 });
  }

  // 3. Anthropic Files API sync (jeśli klucz dostępny). Trzymamy odpowiedź
  // przed response żeby UI dostał anthropic_file_id już teraz — wtedy
  // pierwsza generacja po uploadzie od razu używa pliku.
  let anthropicFileId: string | null = null;
  let extractedSummary: string | null = null;
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const client = getAnthropicClient();
      const upload = await client.beta.files.upload({
        file: await toFile(new Blob([buf], { type: "application/pdf" }), file.name),
      });
      anthropicFileId = upload.id;

      // Krótki extract summary — AI czyta pierwszych kilka stron i opisuje co to
      const summaryAi = await callClaude({
        system: "Jesteś asystentem analizującym dokumenty techniczne dla generatora instrukcji obsługi smartwatchy Locon. Streszczasz pliki referencyjne w 1-3 zdaniach po POLSKU. Wyciągaj konkretne wartości techniczne (np. SAR head/body w W/kg, normy, częstotliwości, IP rating, pojemność baterii, wymiary). Bez fence, bez prozy poza treścią.",
        user: `Streść zawartość załączonego pliku ${kind === "sar_report" ? "(raport SAR)" : kind === "tech_spec" ? "(specyfikacja techniczna)" : kind === "manufacturer_manual" ? "(instrukcja producenta — może być w obcym języku, przetłumacz kluczowe terminy)" : ""} w 1-3 zdaniach. Skup się na konkretnych wartościach które przydadzą się w generowaniu instrukcji obsługi modelu PL.`,
        model: EDIT_MODEL,
        maxTokens: 500,
      });
      extractedSummary = summaryAi.text.trim().slice(0, 2000);
    } catch (err) {
      console.warn("[reference-docs] Anthropic Files sync failed:", err);
      // Nie blokuj uploadu — plik jest w storage, sync można powtórzyć później.
    }

    if (anthropicFileId || extractedSummary) {
      await sb
        .from("gen4_reference_docs")
        .update({
          anthropic_file_id: anthropicFileId,
          extracted_summary: extractedSummary,
        })
        .eq("id", row.id);
    }
  }

  const { data: signed } = await sb.storage.from(BUCKET).createSignedUrl(filePath, 3600);
  return NextResponse.json({
    doc: {
      ...row,
      anthropic_file_id: anthropicFileId,
      extracted_summary: extractedSummary,
      download_url: signed?.signedUrl ?? null,
    },
  });
}
