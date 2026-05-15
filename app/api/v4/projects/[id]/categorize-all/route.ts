/**
 * Bulk auto-categorize wszystkich plikow w projekcie. SSE z progress.
 * Domyslnie idempotent: pomija pliki z kind != 'other' / null.
 * ?force=1 wymusza re-categorize.
 */

import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { callGeminiWithRetry, GEMINI_FLASH } from "@/lib/v4Gemini";
import { logAiCall } from "@/lib/v4AiLog";
import { prepareFileForAi } from "@/lib/v4FileExtract";
import { countPdfPages, chunkPdf, extractPdfText } from "@/lib/v4PdfChunk";
import { callClaude, EDIT_MODEL } from "@/lib/anthropic";
import { z } from "zod";

export const runtime = "nodejs";
export const maxDuration = 300;

const BUCKET = "gen4-reference-docs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const KindSchema = z.object({
  kind: z.enum([
    "sar_report", "tech_spec", "declaration_ce", "manufacturer_manual",
    "emc_report", "rohs_report", "reach_report", "rf_test", "safety_test",
    "risk_assessment", "photos", "certificate", "other",
  ]),
  confidence: z.enum(["high", "medium", "low"]),
  reason: z.string(),
});

const KIND_FALLBACK: Record<string, string> = {
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

const SYS = `Klasyfikujesz dokumenty techniczne. Dokument to JEDEN typ:
sar_report (raport SAR), tech_spec (specyfikacja), declaration_ce (deklaracja CE/RED/RoHS),
manufacturer_manual (instrukcja producenta), emc_report, rohs_report, reach_report,
rf_test (Appendix RF testow), safety_test, risk_assessment, photos, certificate, other.
Zwroc strukturalny output: kind + confidence + 1-2 zdania reason.`;

export async function POST(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  if (!process.env.GEMINI_API_KEY) {
    return new Response(JSON.stringify({ error: "GEMINI_API_KEY not configured" }), { status: 503 });
  }

  const { id: projectId } = await ctx.params;
  const sb = getSupabaseAdmin();

  const { data: project } = await sb.from("gen4_projects").select("owner_email").eq("id", projectId).single();
  if (!project || project.owner_email !== auth.email) {
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  }

  const force = new URL(request.url).searchParams.get("force") === "1";

  const { data: allDocs } = await sb
    .from("gen4_reference_docs")
    .select("id, project_id, kind, name, file_path, mime_type")
    .eq("project_id", projectId)
    .order("created_at", { ascending: true });
  const skipped = force ? [] : (allDocs ?? []).filter((d) => d.kind && d.kind !== "other");
  const targets = force ? (allDocs ?? []) : (allDocs ?? []).filter((d) => !d.kind || d.kind === "other");

  if (targets.length === 0) {
    return new Response(JSON.stringify({
      error: `Brak plikow do kategoryzacji (${skipped.length} juz ma kind != other). Uzyj ?force=1.`,
    }), { status: 400 });
  }

  const encoder = new TextEncoder();
  const startedAt = Date.now();

  const sse = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      send("started", { total: targets.length, skipped: skipped.length });
      const heartbeat = setInterval(() => {
        try { send("ping", { elapsed_ms: Date.now() - startedAt }); } catch { /* closed */ }
      }, 10000);

      let okCount = 0;
      let errCount = 0;
      const errors: Array<{ doc_id: string; name: string; error: string }> = [];

      for (let i = 0; i < targets.length; i++) {
        const doc = targets[i];
        send("progress", { current: i + 1, total: targets.length, doc_name: doc.name, status: "starting" });

        try {
          const { data: dl, error: dlErr } = await sb.storage.from(BUCKET).download(doc.file_path);
          if (dlErr || !dl) throw new Error(`download fail: ${dlErr?.message ?? "no data"}`);

          let buf = Buffer.from(await dl.arrayBuffer());
          let mime = doc.mime_type || "application/pdf";

          if (mime.includes("officedocument") || mime.includes("opendocument")) {
            const prepared = await prepareFileForAi(buf, doc.name, mime);
            buf = Buffer.from(prepared.bytes);
            mime = prepared.mimeType;
          }

          let inlineData = buf;
          let useClaudeFallback = false;
          if (mime === "application/pdf") {
            const pages = await countPdfPages(buf).catch(() => 0);
            if (pages > 50) {
              try {
                const chunks = await chunkPdf(buf, 10);
                if (chunks.length > 0) inlineData = Buffer.from(chunks[0].bytes);
              } catch {
                useClaudeFallback = true;
              }
            }
          }

          let result;
          let inputTokens = 0;
          let outputTokens = 0;
          let modelUsed = GEMINI_FLASH;

          if (useClaudeFallback) {
            const extracted = await extractPdfText(buf);
            const ai = await callClaude({
              system: SYS + "\n\nZwroc JSON: { \"kind\": \"...\", \"confidence\": \"high|medium|low\", \"reason\": \"...\" }",
              user: `Plik: ${doc.name}\nFragment: ${extracted.text.slice(0, 30_000)}`,
              model: EDIT_MODEL,
              maxTokens: 500,
            });
            const cleaned = ai.text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
            result = KindSchema.parse(JSON.parse(cleaned));
            inputTokens = ai.inputTokens;
            outputTokens = ai.outputTokens;
            modelUsed = "claude-haiku-4-5";
          } else {
            const ai = await callGeminiWithRetry({
              system: SYS,
              user: `Plik: ${doc.name}\nSklasyfikuj.`,
              model: GEMINI_FLASH,
              maxTokens: 500,
              outputSchema: { name: "classify_doc", description: "Klasyfikacja", schema: KindSchema },
              inlineFiles: [{ mimeType: mime, data: inlineData.toString("base64") }],
            });
            if (!ai.parsed) throw new Error("Gemini did not return parsed");
            result = ai.parsed;
            inputTokens = ai.inputTokens;
            outputTokens = ai.outputTokens;
            modelUsed = ai.model ?? GEMINI_FLASH;
          }

          const newKind = KIND_FALLBACK[result.kind] ?? "other";
          await sb.from("gen4_reference_docs").update({ kind: newKind }).eq("id", doc.id);

          void logAiCall({
            project_id: projectId,
            endpoint: "reference-docs/categorize-all",
            context_type: "project",
            user_instruction: `categorize ${doc.name}`,
            system_prompt: SYS,
            user_prompt: `Plik: ${doc.name}`,
            model: modelUsed,
            max_tokens: 500,
            response_text: JSON.stringify(result),
            tokens_in: inputTokens,
            tokens_out: outputTokens,
            duration_ms: 0,
            user_email: auth.email,
          });

          okCount++;
          send("progress", {
            current: i + 1,
            total: targets.length,
            doc_name: doc.name,
            status: "done",
            kind: newKind,
            confidence: result.confidence,
            reason: result.reason.slice(0, 100),
          });
        } catch (err) {
          errCount++;
          const msg = err instanceof Error ? err.message : String(err);
          errors.push({ doc_id: doc.id, name: doc.name, error: msg.slice(0, 200) });
          send("progress", { current: i + 1, total: targets.length, doc_name: doc.name, status: "error", error: msg.slice(0, 200) });
        }
      }

      clearInterval(heartbeat);
      send("done", { total: targets.length, ok: okCount, err: errCount, errors, duration_ms: Date.now() - startedAt });
      controller.close();
    },
  });

  return new Response(sse, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
