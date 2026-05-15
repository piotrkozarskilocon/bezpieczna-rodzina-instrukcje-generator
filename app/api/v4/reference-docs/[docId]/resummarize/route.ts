/**
 * Re-uruchamia AI summary dla istniejacego reference_doc.
 *
 * Tlo: wczesniej attachments byly broken (Anthropic Files download fail) i wszystkie
 * summaries zostaly zapisane jako "Nie widze pliku". Po fixie attachments
 * z Supabase Storage trzeba ponownie wywolac summary dla starych plikow.
 *
 * Endpoint: POST /api/v4/reference-docs/[docId]/resummarize
 * Body: {} (nic — kind brany z DB)
 * Response: { ok: true, extracted_summary: "..." }
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { callClaude, EDIT_MODEL } from "@/lib/anthropic";
import { logAiCall } from "@/lib/v4AiLog";

export const runtime = "nodejs";
export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ docId: string }>;
}

export async function POST(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "ANTHROPIC_API_KEY not configured" }, { status: 503 });
  }

  const { docId } = await ctx.params;
  const sb = getSupabaseAdmin();

  const { data: doc, error: selErr } = await sb
    .from("gen4_reference_docs")
    .select("id, project_id, kind, name, mime_type, anthropic_file_id")
    .eq("id", docId)
    .single();
  if (!doc) {
    return NextResponse.json(
      { error: `doc not found: ${selErr?.message ?? "no row"}` },
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

  if (!doc.anthropic_file_id) {
    return NextResponse.json(
      { error: "doc nie ma anthropic_file_id (upload byc moze sie nie zakonczyl)" },
      { status: 400 },
    );
  }

  const kind = doc.kind ?? "other";
  const summarySystem = "Jesteś asystentem analizującym dokumenty techniczne dla generatora instrukcji obsługi smartwatchy Locon. Streszczasz pliki referencyjne w 1-3 zdaniach po POLSKU. Wyciągaj konkretne wartości techniczne (np. SAR head/body w W/kg, normy, częstotliwości, IP rating, pojemność baterii, wymiary). Bez fence, bez prozy poza treścią.";
  const summaryUser = `Streść zawartość załączonego pliku ${
    kind === "sar_report" ? "(raport SAR)"
    : kind === "tech_spec" ? "(specyfikacja techniczna)"
    : kind === "manufacturer_manual" ? "(instrukcja producenta — może być w obcym języku, przetłumacz kluczowe terminy)"
    : kind === "declaration_ce" ? "(deklaracja zgodności CE)"
    : ""
  } w 1-3 zdaniach. Skup się na konkretnych wartościach które przydadzą się w generowaniu instrukcji obsługi modelu PL.`;

  const startedAt = Date.now();
  try {
    const summaryAi = await callClaude({
      system: summarySystem,
      user: summaryUser,
      model: EDIT_MODEL,
      maxTokens: 500,
      attachments: [doc.anthropic_file_id],
    });
    const extractedSummary = summaryAi.text.trim().slice(0, 2000);

    await sb
      .from("gen4_reference_docs")
      .update({ extracted_summary: extractedSummary })
      .eq("id", docId);

    void logAiCall({
      project_id: doc.project_id,
      endpoint: "reference-docs/resummarize",
      context_type: "project",
      user_instruction: `resummarize ${doc.name}`,
      system_prompt: summarySystem,
      user_prompt: summaryUser,
      model: summaryAi.model,
      max_tokens: 500,
      response_text: summaryAi.text,
      tokens_in: summaryAi.inputTokens,
      tokens_out: summaryAi.outputTokens,
      duration_ms: Date.now() - startedAt,
      user_email: auth.email,
    });

    return NextResponse.json({
      ok: true,
      doc_id: docId,
      extracted_summary: extractedSummary,
      tokens_in: summaryAi.inputTokens,
      tokens_out: summaryAi.outputTokens,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "summary failed";
    void logAiCall({
      project_id: doc.project_id,
      endpoint: "reference-docs/resummarize",
      context_type: "project",
      user_instruction: `resummarize ${doc.name}`,
      system_prompt: summarySystem,
      user_prompt: summaryUser,
      model: EDIT_MODEL,
      max_tokens: 500,
      error: msg,
      duration_ms: Date.now() - startedAt,
      user_email: auth.email,
    });
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
