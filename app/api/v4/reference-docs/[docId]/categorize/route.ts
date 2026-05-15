/**
 * AI auto-categorize kind dla reference_doc.
 *
 * POST /api/v4/reference-docs/[docId]/categorize
 * Body: {} (nic, czyta plik z storage)
 * Response: { ok: true, kind: 'sar_report' | 'tech_spec' | ..., confidence?: string }
 *
 * Wywoluje Gemini Flash z structured output - pyta o kind enum. Plik dostarczany
 * inline (do 20MB) z prepareFileForAi dla DOCX/XLSX, chunking dla wielostronicowych PDF.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { callGeminiWithRetry, GEMINI_FLASH } from "@/lib/v4Gemini";
import { logAiCall } from "@/lib/v4AiLog";
import { prepareFileForAi } from "@/lib/v4FileExtract";
import { countPdfPages, chunkPdf, extractPdfText, MAX_PAGES_PER_CHUNK } from "@/lib/v4PdfChunk";
import { callClaude, EDIT_MODEL } from "@/lib/anthropic";
import { z } from "zod";

export const runtime = "nodejs";
export const maxDuration = 60;

const BUCKET = "gen4-reference-docs";

interface RouteContext {
  params: Promise<{ docId: string }>;
}

const KindSchema = z.object({
  kind: z.enum([
    "sar_report",
    "tech_spec",
    "declaration_ce",
    "manufacturer_manual",
    "emc_report",
    "rohs_report",
    "reach_report",
    "rf_test",
    "safety_test",
    "risk_assessment",
    "photos",
    "certificate",
    "other",
  ]).describe("Wykryty typ dokumentu"),
  confidence: z.enum(["high", "medium", "low"]).describe("Pewnosc detekcji"),
  reason: z.string().describe("1-2 zdania dlaczego ten typ"),
});

// Mapowanie naszych extended typów na user-facing 4 kindy:
const KIND_FALLBACK: Record<string, "sar_report" | "tech_spec" | "declaration_ce" | "manufacturer_manual" | "other"> = {
  sar_report: "sar_report",
  tech_spec: "tech_spec",
  declaration_ce: "declaration_ce",
  manufacturer_manual: "manufacturer_manual",
  emc_report: "other",
  rohs_report: "other",
  reach_report: "other",
  rf_test: "other",
  safety_test: "other",
  risk_assessment: "other",
  photos: "other",
  certificate: "other",
  other: "other",
};

export async function POST(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!process.env.GEMINI_API_KEY) {
    return NextResponse.json({ error: "GEMINI_API_KEY not configured" }, { status: 503 });
  }

  const { docId } = await ctx.params;
  const sb = getSupabaseAdmin();

  const { data: doc } = await sb
    .from("gen4_reference_docs")
    .select("id, project_id, kind, name, file_path, mime_type")
    .eq("id", docId)
    .single();
  if (!doc) return NextResponse.json({ error: "doc not found" }, { status: 404 });

  const { data: project } = await sb
    .from("gen4_projects")
    .select("owner_email")
    .eq("id", doc.project_id)
    .single();
  if (!project || project.owner_email !== auth.email) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const { data: dl, error: dlErr } = await sb.storage.from(BUCKET).download(doc.file_path);
  if (dlErr || !dl) {
    return NextResponse.json({ error: `download fail: ${dlErr?.message ?? "no data"}` }, { status: 500 });
  }
  let buf = Buffer.from(await dl.arrayBuffer());
  let mime = doc.mime_type || "application/pdf";

  if (mime.includes("officedocument") || mime.includes("opendocument")) {
    const prepared = await prepareFileForAi(buf, doc.name, mime);
    buf = Buffer.from(prepared.bytes);
    mime = prepared.mimeType;
  }

  const startedAt = Date.now();
  const sys = `Jestes ekspertem klasyfikujacym dokumenty techniczne dla urzadzen elektronicznych — smartwatchy, trackerow, opasek.

Dokument to JEDEN z typow (kind enum):
- sar_report — raport pomiarow SAR (Specific Absorption Rate), zwykle 50-500 stron tabel pomiarowych z wartosciami W/kg dla glowy/ciala/konczyn
- tech_spec — specyfikacja techniczna producenta (battery, IP, dimensions, frequencies)
- declaration_ce — Deklaracja zgodnosci CE / RED / RoHS (kratki dokument prawny z lista dyrektyw i sygnatariuszem)
- manufacturer_manual — instrukcja obslugi producenta (czesto chinska/angielska, opisy funkcji + procedury)
- emc_report — raport testow EMC (ETSI EN 301 489, EN 55032, etc.)
- rohs_report — raport zgodnosci RoHS (analiza substancji szkodliwych)
- reach_report — raport REACH (substancje SVHC, kandydaci, analiza chemiczna)
- rf_test — raport testow RF (Appendix dla GSM/WCDMA/LTE/blocking/extreme/normal conditions)
- safety_test — raport testow bezpieczenstwa (EN 62368-1, IEC 62133 baterie)
- risk_assessment — ocena ryzyka radio equipment directive
- photos — zdjecia urzadzenia (EUT photo, mechanical photos)
- certificate — certyfikat (FCC, WEEE, jakikolwiek inny)
- other — cokolwiek innego

Czytasz dokument (lub jego fragment) i zwracasz strukturalny output: kind + confidence + krotki reason.`;

  const userPrompt = `Plik: ${doc.name}
Mime: ${mime}

Sklasyfikuj ten dokument do jednego z typow zgodnie z systemem.`;

  let ai;
  let usedClaude = false;
  try {
    // PDF chunking: jezeli > 400 stron, weź TYLKO pierwsze 10 stron do klasyfikacji.
    // Klasyfikacja nie wymaga calego dokumentu, na 1-10 stronie zwykle widac typ.
    let inlineData = buf;
    if (mime === "application/pdf") {
      const pageCount = await countPdfPages(buf).catch(() => 0);
      if (pageCount > 50) {
        try {
          // Take just first 10 pages for classification — szybciej i bezpiecznie pod limitami.
          const chunks = await chunkPdf(buf, 10);
          if (chunks.length > 0) inlineData = Buffer.from(chunks[0].bytes);
        } catch {
          // Chunk fail → text fallback do Claude
          const extracted = await extractPdfText(buf);
          const text = extracted.text.slice(0, 50_000);
          // Claude prepaid jako fallback dla problematycznych PDF
          const claudeAi = await callClaude({
            system: sys + "\n\nZwroc JSON: { \"kind\": \"...\", \"confidence\": \"high|medium|low\", \"reason\": \"...\" }",
            user: `${userPrompt}\n\nFragment tekstu z dokumentu:\n\n${text}`,
            model: EDIT_MODEL,
            maxTokens: 500,
          });
          let parsed;
          try {
            const cleaned = claudeAi.text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
            parsed = KindSchema.parse(JSON.parse(cleaned));
          } catch {
            return NextResponse.json({
              error: "Claude fallback nie zwrocil poprawnego JSON",
              raw: claudeAi.text.slice(0, 500),
            }, { status: 502 });
          }
          usedClaude = true;
          ai = { parsed, inputTokens: claudeAi.inputTokens, outputTokens: claudeAi.outputTokens, text: claudeAi.text, model: claudeAi.model };
        }
      }
    }

    if (!ai) {
      ai = await callGeminiWithRetry({
        system: sys,
        user: userPrompt,
        model: GEMINI_FLASH,
        maxTokens: 500,
        outputSchema: {
          name: "classify_doc",
          description: "Klasyfikacja typu dokumentu technicznego",
          schema: KindSchema,
        },
        inlineFiles: [{ mimeType: mime, data: inlineData.toString("base64") }],
      });
    }

    const result = ai.parsed;
    if (!result) {
      return NextResponse.json({ error: "AI did not return parsed kind" }, { status: 502 });
    }

    const newKind = KIND_FALLBACK[result.kind] ?? "other";

    await sb
      .from("gen4_reference_docs")
      .update({ kind: newKind })
      .eq("id", docId);

    void logAiCall({
      project_id: doc.project_id,
      endpoint: "reference-docs/categorize",
      context_type: "project",
      user_instruction: `categorize ${doc.name}`,
      system_prompt: sys,
      user_prompt: userPrompt,
      model: usedClaude ? "claude-haiku-4-5" : ai.model ?? GEMINI_FLASH,
      max_tokens: 500,
      response_text: JSON.stringify(result),
      tokens_in: ai.inputTokens,
      tokens_out: ai.outputTokens,
      duration_ms: Date.now() - startedAt,
      user_email: auth.email,
    });

    return NextResponse.json({
      ok: true,
      kind: newKind,
      detected_extended_kind: result.kind,
      confidence: result.confidence,
      reason: result.reason,
      used_claude: usedClaude,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "AI failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
