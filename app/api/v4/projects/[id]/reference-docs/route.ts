import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { getAnthropicClient, callClaude, EDIT_MODEL } from "@/lib/anthropic";
import { toFile } from "@anthropic-ai/sdk/core/uploads";
import {
  ACCEPTED_MIME_TYPES,
  normalizeMime,
  prepareFileForAi,
} from "@/lib/v4FileExtract";
import { logAiCall } from "@/lib/v4AiLog";

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

  // Dwa warianty body:
  //  A) JSON { file_path, name, kind, source_lang, size_bytes, mime_type } —
  //     plik został już uploadowany direct przez signed URL (omija Vercel 4.5 MB cap).
  //  B) multipart form-data (legacy, dla małych plików < 4.5 MB).
  const contentType = request.headers.get("content-type") ?? "";
  let filePath: string;
  let kind = "other";
  let sourceLang = "pl";
  let fileName = "";
  let fileSize = 0;
  let fileMime = "application/pdf";
  let buf: Buffer | null = null;

  if (contentType.includes("application/json")) {
    // Wariant A: direct upload już zrobiony
    const body = (await request.json().catch(() => null)) as
      | { file_path?: string; name?: string; kind?: string; source_lang?: string; size_bytes?: number; mime_type?: string }
      | null;
    if (!body?.file_path?.trim() || !body?.name?.trim()) {
      return NextResponse.json({ error: "missing file_path or name" }, { status: 400 });
    }
    // Walidacja że path zaczyna się od projectId (anti-cross-project)
    if (!body.file_path.startsWith(`${id}/`)) {
      return NextResponse.json({ error: "invalid file_path (must start with project id)" }, { status: 400 });
    }
    filePath = body.file_path;
    fileName = body.name.slice(0, 200);
    fileSize = typeof body.size_bytes === "number" ? body.size_bytes : 0;
    const normalizedType = normalizeMime(body.mime_type ?? null, fileName);
    if (!normalizedType || !ACCEPTED_MIME_TYPES.has(normalizedType)) {
      return NextResponse.json(
        { error: "nieobsługiwany typ pliku — wgraj PDF, TXT, MD, CSV, JSON, DOCX lub XLSX" },
        { status: 415 },
      );
    }
    fileMime = normalizedType;
    if (fileSize > MAX_BYTES) {
      return NextResponse.json({ error: `file too large (max 25 MB)` }, { status: 413 });
    }
    if (body.kind && VALID_KINDS.has(body.kind)) kind = body.kind;
    if (body.source_lang) sourceLang = body.source_lang.toLowerCase().slice(0, 5);
    // Pobierz bytes dla Anthropic Files API sync (plik już jest w bucket).
    const { data: blob, error: dlErr } = await sb.storage.from(BUCKET).download(filePath);
    if (dlErr || !blob) {
      return NextResponse.json({ error: `download from storage failed: ${dlErr?.message ?? "blob null"}` }, { status: 500 });
    }
    buf = Buffer.from(await blob.arrayBuffer());
  } else {
    // Wariant B: multipart (legacy)
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return NextResponse.json({ error: "expected multipart/form-data or application/json" }, { status: 400 });
    }
    const f = formData.get("file");
    if (!(f instanceof File)) {
      return NextResponse.json({ error: "missing file field" }, { status: 400 });
    }
    if (f.size > MAX_BYTES) {
      return NextResponse.json({ error: `file too large (max 25 MB)` }, { status: 413 });
    }
    const normalizedType = normalizeMime(f.type, f.name);
    if (!normalizedType || !ACCEPTED_MIME_TYPES.has(normalizedType)) {
      return NextResponse.json(
        { error: "nieobsługiwany typ pliku — wgraj PDF, TXT, MD, CSV, JSON, DOCX lub XLSX" },
        { status: 415 },
      );
    }
    fileName = f.name.slice(0, 200);
    fileSize = f.size;
    fileMime = normalizedType;
    const kindRaw = formData.get("kind");
    if (typeof kindRaw === "string" && VALID_KINDS.has(kindRaw)) kind = kindRaw;
    sourceLang = (formData.get("source_lang") as string | null)?.toLowerCase()?.slice(0, 5) ?? "pl";

    const safeName = f.name.replace(/[^\w.\-]+/g, "_").slice(0, 100);
    filePath = `${id}/${Date.now()}-${safeName}`;
    buf = Buffer.from(await f.arrayBuffer());
    const { error: uploadErr } = await sb.storage
      .from(BUCKET)
      .upload(filePath, buf, { contentType: f.type, upsert: false });
    if (uploadErr) {
      return NextResponse.json({ error: `storage upload failed: ${uploadErr.message}` }, { status: 500 });
    }
  }

  // 2. Insert row
  const { data: row, error: insertErr } = await sb
    .from("gen4_reference_docs")
    .insert({
      project_id: id,
      kind,
      source_lang: sourceLang,
      name: fileName,
      file_path: filePath,
      size_bytes: fileSize,
      mime_type: fileMime,
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
  // pierwsza generacja po uploadzie od razu używa pliku. DOCX/XLSX są
  // konwertowane do tekstu/CSV po stronie serwera bo Anthropic Files API
  // nie akceptuje binarnych formatów Office.
  let anthropicFileId: string | null = null;
  let extractedSummary: string | null = null;
  if (process.env.ANTHROPIC_API_KEY && buf) {
    try {
      const prepared = await prepareFileForAi(buf, fileName, fileMime);
      const client = getAnthropicClient();
      const upload = await client.beta.files.upload({
        file: await toFile(
          new Blob([new Uint8Array(prepared.bytes)], { type: prepared.mimeType }),
          prepared.filename,
        ),
      });
      anthropicFileId = upload.id;

      // Krótki extract summary — AI czyta pierwszych kilka stron i opisuje co to.
      // Dla skonwertowanych dodajemy info do user prompt żeby AI wiedział że to
      // tekst z DOCX/XLSX (a nie oryginalny PDF).
      const convertedNote = prepared.converted
        ? ` (oryginalnie ${fileMime.includes("word") ? "DOCX" : "XLSX"} — skonwertowany do tekstu)`
        : "";
      const summarySystem = "Jesteś asystentem analizującym dokumenty techniczne dla generatora instrukcji obsługi smartwatchy Locon. Streszczasz pliki referencyjne w 1-3 zdaniach po POLSKU. Wyciągaj konkretne wartości techniczne (np. SAR head/body w W/kg, normy, częstotliwości, IP rating, pojemność baterii, wymiary). Bez fence, bez prozy poza treścią.";
      const summaryUser = `Streść zawartość załączonego pliku${convertedNote} ${kind === "sar_report" ? "(raport SAR)" : kind === "tech_spec" ? "(specyfikacja techniczna)" : kind === "manufacturer_manual" ? "(instrukcja producenta — może być w obcym języku, przetłumacz kluczowe terminy)" : ""} w 1-3 zdaniach. Skup się na konkretnych wartościach które przydadzą się w generowaniu instrukcji obsługi modelu PL.`;
      const summaryStartedAt = Date.now();
      const summaryAi = await callClaude({
        system: summarySystem,
        user: summaryUser,
        model: EDIT_MODEL,
        maxTokens: 500,
        attachments: [anthropicFileId],
      });
      extractedSummary = summaryAi.text.trim().slice(0, 2000);
      void logAiCall({
        project_id: id,
        endpoint: "reference-docs/summary",
        context_type: "project",
        user_instruction: `summary of uploaded ${kind ?? "document"}: ${fileName.slice(0, 100)}`,
        system_prompt: summarySystem,
        user_prompt: summaryUser,
        model: summaryAi.model,
        max_tokens: 500,
        response_text: summaryAi.text,
        tokens_in: summaryAi.inputTokens,
        tokens_out: summaryAi.outputTokens,
        duration_ms: Date.now() - summaryStartedAt,
        user_email: auth.email,
      });
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
