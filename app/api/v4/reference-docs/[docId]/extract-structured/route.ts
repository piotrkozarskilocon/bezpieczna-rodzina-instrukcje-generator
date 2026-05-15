/**
 * Strukturalna ekstrakcja z reference doc (raport SAR, tech spec) przez
 * Gemini 2.5 Pro Vision. Wynik zapisany do gen4_reference_docs.extracted_structured
 * (jsonb) — uzywany pozniej w system prompcie generacji jako konkretne
 * wartosci (zamiast placeholdera "DO UZUPELNIENIA").
 *
 * Body: { kind?: "sar" } — na razie tylko SAR. W przyszlosci kind=tech_spec
 * z inna schema (specifications: { battery_mah, ip_rating, frequencies, ... }).
 *
 * Faza 2 z deep research planu. Wymaga GEMINI_API_KEY + migracji 0021.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { callGemini, GEMINI_FLASH } from "@/lib/v4Gemini";
import { SarReportSchema, type SarReport } from "@/lib/v4Schemas";
import { logAiCall } from "@/lib/v4AiLog";

export const runtime = "nodejs";
export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ docId: string }>;
}

const BUCKET = "gen4-reference-docs";

const SAR_SYSTEM = `Jestes ekspertem w analizie raportow SAR (Specific Absorption Rate) dla urzadzen radiowych — smartwatchy, trackerow GPS, opasek seniora. Czytasz pelen raport SAR (zwykle 50-500 stron PDF, czesto po angielsku lub chinsku) i wyciagasz konkretne wartosci pomiarowe + meta.

Twoja praca:
1. Identyfikuj model urzadzenia i numer certyfikatu.
2. Wyciagnij wartosci SAR (W/kg) per scenariusz pomiarowy:
   - head: pomiar przy glowie (zwykle worst-case z roznych pozycji)
   - body: pomiar przy ciele (zwykle z 0-5mm separation distance)
   - limb: pomiar konczyny (jezeli zmierzone)
3. Dla kazdego pomiaru: averaging mass (1g dla FCC, 10g dla ICNIRP/EU), band, frequency, separation distance jezeli podane.
4. Wymien wszystkie testowane pasma + zakresy frekwencji.
5. Wymien zastosowane normy (np. EN 62209-1, IEC 62209, FCC OET 65).
6. Wartosci LICZBOWE — nie wymyslaj. Jezeli raport nie zawiera danej kategorii, pomin (zostaw null/undefined).

Zwracaj WYLACZNIE strukturalny JSON wg schemy submit_sar_report. Bez prozy, bez fence.`;

export async function POST(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  if (!process.env.GEMINI_API_KEY) {
    return NextResponse.json(
      { error: "GEMINI_API_KEY not configured" },
      { status: 503 },
    );
  }

  const { docId } = await ctx.params;
  const sb = getSupabaseAdmin();

  // Auth check + pobierz metadata pliku
  const { data: doc, error: selErr } = await sb
    .from("gen4_reference_docs")
    .select("id, project_id, kind, name, file_path, mime_type, anthropic_file_id")
    .eq("id", docId)
    .single();
  if (!doc) {
    return NextResponse.json(
      { error: `doc not found (id=${docId}): ${selErr?.message ?? "no row"}` },
      { status: 404 },
    );
  }

  const { data: project } = await sb
    .from("gen4_projects")
    .select("owner_email")
    .eq("id", doc.project_id)
    .single();
  if (!project || project.owner_email !== auth.email) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Sciagamy PDF/text bytes z Supabase Storage. Mamy juz file w Storage od
  // czasu uploadu (rowniez gdy Anthropic Files sync zostal zrobiony — Storage
  // jest source of truth).
  const { data: download, error: dlErr } = await sb.storage.from(BUCKET).download(doc.file_path);
  if (dlErr || !download) {
    return NextResponse.json({ error: `download failed: ${dlErr?.message ?? "unknown"}` }, { status: 500 });
  }

  const buf = Buffer.from(await download.arrayBuffer());
  const base64 = buf.toString("base64");
  const mimeType = doc.mime_type || "application/pdf";

  // Gemini inline file limit ~20MB. Wieksze pliki wymagaja Files API —
  // dorobimy gdy bedzie potrzeba (typowy raport SAR ~5-15MB miesci sie).
  if (buf.length > 20 * 1024 * 1024) {
    return NextResponse.json(
      { error: `file too large for inline (${(buf.length / 1024 / 1024).toFixed(1)}MB > 20MB). Files API integration TODO.` },
      { status: 413 },
    );
  }

  const userPrompt = `Plik referencyjny: ${doc.name}
Typ: ${doc.kind ?? "(nieznany)"}
Mime: ${mimeType}

Wyciagnij strukturalne wartosci SAR + meta z zalaczonego raportu. Jezeli to nie raport SAR a innego typu dokument (np. specyfikacja techniczna bez pomiarow) — zwroc minimalny obiekt z device_model + notes opisujace co to za dokument.`;

  const startedAt = Date.now();
  let ai;
  try {
    ai = await callGemini<SarReport>({
      system: SAR_SYSTEM,
      user: userPrompt,
      model: GEMINI_FLASH,
      maxTokens: 4000,
      outputSchema: {
        name: "submit_sar_report",
        description: "Strukturalna ekstrakcja wartosci SAR + meta z raportu",
        schema: SarReportSchema,
      },
      inlineFiles: [{ mimeType, data: base64 }],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Gemini call failed";
    void logAiCall({
      project_id: doc.project_id,
      endpoint: "reference-docs/extract-structured",
      context_type: "project",
      user_instruction: `extract structured from ${doc.name}`,
      system_prompt: SAR_SYSTEM,
      user_prompt: userPrompt,
      model: GEMINI_FLASH,
      max_tokens: 4000,
      error: msg,
      duration_ms: Date.now() - startedAt,
      user_email: auth.email,
    });
    return NextResponse.json({ error: `Gemini extraction failed: ${msg}` }, { status: 502 });
  }

  // Log success
  void logAiCall({
    project_id: doc.project_id,
    endpoint: "reference-docs/extract-structured",
    context_type: "project",
    user_instruction: `extract structured from ${doc.name}`,
    system_prompt: SAR_SYSTEM,
    user_prompt: userPrompt,
    model: ai.model,
    max_tokens: 4000,
    response_text: ai.text,
    tokens_in: ai.inputTokens,
    tokens_out: ai.outputTokens,
    duration_ms: Date.now() - startedAt,
    user_email: auth.email,
  });

  const structured = ai.parsed;
  if (!structured) {
    return NextResponse.json(
      { error: "Gemini did not return parsed structured output", raw: ai.text.slice(0, 500) },
      { status: 502 },
    );
  }

  // Zapis do bazy.
  const { error: updateErr } = await sb
    .from("gen4_reference_docs")
    .update({
      extracted_structured: structured,
      extracted_structured_at: new Date().toISOString(),
      extracted_structured_model: ai.model,
    })
    .eq("id", docId);
  if (updateErr) {
    return NextResponse.json({ error: `DB update failed: ${updateErr.message}` }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    extracted: structured,
    model: ai.model,
    tokens_in: ai.inputTokens,
    tokens_out: ai.outputTokens,
    duration_ms: Date.now() - startedAt,
  });
}
