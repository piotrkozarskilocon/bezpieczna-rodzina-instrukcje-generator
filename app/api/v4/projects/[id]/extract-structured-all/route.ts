/**
 * Bulk strukturalna ekstrakcja wartości AI dla WSZYSTKICH plików referencyjnych
 * projektu. Per-doc wywołuje Gemini z odpowiednim schema (SAR/tech_spec/manual/
 * declaration_ce/generic). Wzorowane na resummarize-all.
 *
 * SSE — 'started' → N × 'progress' → 'done'. Idempotent: pomija pliki z istniejącym
 * extracted_structured (override przez ?force=1). Heartbeat co 10s (Hub Edge
 * middleware proxy zamyka po ~25-30s bezruchu).
 */

import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { callGeminiWithRetry, GEMINI_FLASH } from "@/lib/v4Gemini";
import { logAiCall } from "@/lib/v4AiLog";
import {
  SarReportSchema,
  TechSpecSchema,
  DeclarationCeSchema,
  ManufacturerManualSchema,
  GenericDocSchema,
} from "@/lib/v4Schemas";
import type { ZodSchema } from "zod";

export const runtime = "nodejs";
export const maxDuration = 300;

const BUCKET = "gen4-reference-docs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface DocRow {
  id: string;
  kind: string | null;
  name: string;
  file_path: string;
  mime_type: string | null;
  extracted_structured: Record<string, unknown> | null;
}

const SAR_SYSTEM = `Jestes ekspertem w analizie raportow SAR. Wyciagasz konkretne wartosci pomiarowe (head/body/limb SAR W/kg, averaging mass, bands, frequencies, separation distance) + meta (model, certyfikat, normy). Wartosci LICZBOWE — nie wymyslaj. Zwracaj WYLACZNIE JSON wg schemy submit_sar_report.`;
const TECH_SPEC_SYSTEM = `Jestes ekspertem analizujacym specyfikacje techniczne urzadzen. Wyciagasz: model, producent, bateria mAh, IP rating, waga, wymiary, temperatura pracy, pasma RF (MHz), konektywnosc, czujniki, feature_descriptions (KAZDA funkcja 2-5 zdan), key_use_cases. Nie wymyslaj. Zwracaj WYLACZNIE JSON wg schemy submit_tech_spec.`;
const DECLARATION_SYSTEM = `Jestes ekspertem analizujacym deklaracje zgodnosci CE / RED / RoHS. Wyciagasz: model, producent, dyrektywy, normy, sygnatariusz, jednostka notyfikowana, data. Wartosci doslownie — to dokument prawny. Zwracaj WYLACZNIE JSON wg schemy submit_declaration.`;
const MANUAL_SYSTEM = `Jestes ekspertem analizujacym instrukcje obslugi producenta. Wyciagasz BOGATA strukture: device_model, manufacturer, language, sections_found, key_specs, feature_descriptions (KAZDA funkcja 2-5 zdan PEŁNY opis), setup_steps, app_pairing, key_procedures (SOS/reset/firmware), troubleshooting, warnings. Dla manualow obcojezycznych tlumacz na polski. Zwracaj WYLACZNIE JSON wg schemy submit_manual_summary.`;
const GENERIC_SYSTEM = `Jestes ekspertem analizujacym rozne dokumenty (EMC, RoHS, REACH, RF tests, certyfikaty, broszury, manuale). Wykrywasz typ + wyciagasz key_values (wartosci pomiarowe), feature_descriptions, procedures, quoted_passages, warnings, summary. Dla obcojezycznych tlumacz na polski. Zwracaj WYLACZNIE JSON wg schemy submit_generic_doc.`;

interface SchemaConfig {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema: ZodSchema<any>;
  system: string;
  name: string;
  description: string;
}

function pickSchemaForKind(kind: string | null): SchemaConfig {
  switch (kind) {
    case "sar_report":
      return { schema: SarReportSchema, system: SAR_SYSTEM, name: "submit_sar_report", description: "Strukturalna ekstrakcja SAR" };
    case "tech_spec":
      return { schema: TechSpecSchema, system: TECH_SPEC_SYSTEM, name: "submit_tech_spec", description: "Specyfikacja techniczna" };
    case "declaration_ce":
      return { schema: DeclarationCeSchema, system: DECLARATION_SYSTEM, name: "submit_declaration", description: "Deklaracja CE" };
    case "manufacturer_manual":
      return { schema: ManufacturerManualSchema, system: MANUAL_SYSTEM, name: "submit_manual_summary", description: "Manual producenta" };
    default:
      return { schema: GenericDocSchema, system: GENERIC_SYSTEM, name: "submit_generic_doc", description: "Adaptive ekstrakcja" };
  }
}

export async function POST(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }
  if (!process.env.GEMINI_API_KEY) {
    return new Response(JSON.stringify({ error: "GEMINI_API_KEY not configured" }), { status: 503 });
  }

  const { id: projectId } = await ctx.params;
  const sb = getSupabaseAdmin();

  const { data: project } = await sb
    .from("gen4_projects")
    .select("owner_email")
    .eq("id", projectId)
    .single();
  if (!project || project.owner_email !== auth.email) {
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  }

  const force = new URL(request.url).searchParams.get("force") === "1";

  const { data: docs } = await sb
    .from("gen4_reference_docs")
    .select("id, kind, name, file_path, mime_type, extracted_structured")
    .eq("project_id", projectId)
    .order("created_at", { ascending: true });
  const docsAll = (docs ?? []) as DocRow[];
  const skipped = force ? [] : docsAll.filter((d) => d.extracted_structured != null);
  const todo = force ? docsAll : docsAll.filter((d) => d.extracted_structured == null);

  if (todo.length === 0) {
    return new Response(JSON.stringify({
      error: `Brak plikow do ekstrakcji (${skipped.length} juz ma wartosci). Uzyj ?force=1 aby re-extract.`,
    }), { status: 400 });
  }

  const encoder = new TextEncoder();
  const startedAt = Date.now();

  const sse = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      send("started", {
        total: todo.length,
        project_id: projectId,
        skipped: skipped.length,
        skipped_note: skipped.length > 0 ? `Pominieto ${skipped.length} plikow z istniejacymi wartosciami` : null,
      });

      const heartbeat = setInterval(() => {
        try { send("ping", { elapsed_ms: Date.now() - startedAt }); } catch { /* closed */ }
      }, 10000);

      let okCount = 0;
      let errCount = 0;
      const errors: Array<{ doc_id: string; name: string; error: string }> = [];

      for (let i = 0; i < todo.length; i++) {
        const doc = todo[i];
        send("progress", { current: i + 1, total: todo.length, doc_name: doc.name, status: "starting" });

        try {
          const { data: dl, error: dlErr } = await sb.storage.from(BUCKET).download(doc.file_path);
          if (dlErr || !dl) throw new Error(`download fail: ${dlErr?.message ?? "no data"}`);
          const buf = Buffer.from(await dl.arrayBuffer());
          const mime = doc.mime_type || "application/pdf";

          // Gemini inline limit 20MB. Wieksze pliki — pomijamy z konkretnym komunikatem,
          // Files API integration TODO (rzadkie — manuale chińskie ~5-15MB miesci sie).
          if (buf.length > 20 * 1024 * 1024) {
            throw new Error(`za duzy plik (${(buf.length / 1024 / 1024).toFixed(1)}MB > 20MB inline limit)`);
          }

          const base64 = buf.toString("base64");
          const cfg = pickSchemaForKind(doc.kind);
          const userPrompt = `Plik: ${doc.name}
Typ: ${doc.kind ?? "(brak)"}
Mime: ${mime}

Wyciagnij strukturalne wartosci wg schemy ${cfg.name}.
Jezeli typ nie pasuje do realnej zawartosci — wypelnij co potrafisz i opisz realny typ w polu 'notes' / 'detected_doc_type'.`;

          const docStartedAt = Date.now();
          const ai = await callGeminiWithRetry({
            system: cfg.system,
            user: userPrompt,
            model: GEMINI_FLASH,
            maxTokens: 16000,
            outputSchema: { name: cfg.name, description: cfg.description, schema: cfg.schema },
            inlineFiles: [{ mimeType: mime, data: base64 }],
          });

          const structured = ai.parsed;
          if (!structured) {
            throw new Error(`Gemini did not return parsed structured output (truncacja max_tokens?)`);
          }

          const { error: updateErr } = await sb
            .from("gen4_reference_docs")
            .update({
              extracted_structured: structured,
              extracted_structured_at: new Date().toISOString(),
              extracted_structured_model: ai.model,
            })
            .eq("id", doc.id);

          if (updateErr) throw new Error(`DB update failed: ${updateErr.message}`);

          void logAiCall({
            project_id: projectId,
            endpoint: "reference-docs/extract-structured-all",
            context_type: "project",
            user_instruction: `bulk extract ${doc.name}`,
            system_prompt: cfg.system,
            user_prompt: userPrompt,
            model: ai.model,
            max_tokens: 16000,
            response_text: ai.text,
            tokens_in: ai.inputTokens,
            tokens_out: ai.outputTokens,
            duration_ms: Date.now() - docStartedAt,
            user_email: auth.email,
          });

          okCount++;
          send("progress", {
            current: i + 1,
            total: todo.length,
            doc_name: doc.name,
            status: "done",
            kind: doc.kind ?? "other",
            tokens_in: ai.inputTokens,
            tokens_out: ai.outputTokens,
            duration_ms: Date.now() - docStartedAt,
          });
        } catch (err) {
          errCount++;
          const msg = err instanceof Error ? err.message : String(err);
          errors.push({ doc_id: doc.id, name: doc.name, error: msg.slice(0, 300) });
          send("progress", {
            current: i + 1,
            total: todo.length,
            doc_name: doc.name,
            status: "error",
            error: msg.slice(0, 300),
          });
        }
      }

      clearInterval(heartbeat);
      send("done", {
        total: todo.length,
        ok: okCount,
        err: errCount,
        errors,
        duration_ms: Date.now() - startedAt,
      });
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
