/**
 * Bulk re-summary dla WSZYSTKICH plikow projektu.
 * Pojedyncze /reference-docs/[id]/resummarize ma sens dla nowo wgranego pliku;
 * gdy user chce "uratowac" projekt ze starymi summary "Nie widze pliku",
 * ten endpoint przelatuje wszystkie pliki w petli.
 *
 * SSE — emituje 'progress' co plik + 'done' na koniec. 26 plikow x ~5-30s
 * = az do kilku minut, wiec keepalive heartbeat tez.
 */

import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { callGeminiWithRetry, GEMINI_FLASH } from "@/lib/v4Gemini";
import { logAiCall } from "@/lib/v4AiLog";

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

  const { data: docs } = await sb
    .from("gen4_reference_docs")
    .select("id, kind, name, file_path, mime_type")
    .eq("project_id", projectId)
    .order("created_at", { ascending: true });
  const allDocs = (docs ?? []) as DocRow[];

  if (allDocs.length === 0) {
    return new Response(JSON.stringify({ error: "Brak plikow referencyjnych w projekcie" }), { status: 400 });
  }

  const encoder = new TextEncoder();
  const startedAt = Date.now();

  const sse = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      send("started", { total: allDocs.length, project_id: projectId });

      const heartbeat = setInterval(() => {
        try { send("ping", { elapsed_ms: Date.now() - startedAt }); } catch { /* closed */ }
      }, 10000);

      let okCount = 0;
      let errCount = 0;
      const errors: Array<{ doc_id: string; name: string; error: string }> = [];

      for (let i = 0; i < allDocs.length; i++) {
        const doc = allDocs[i];
        send("progress", {
          current: i + 1,
          total: allDocs.length,
          doc_name: doc.name,
          status: "starting",
        });

        try {
          const { data: dl, error: dlErr } = await sb.storage.from(BUCKET).download(doc.file_path);
          if (dlErr || !dl) {
            throw new Error(`download fail: ${dlErr?.message ?? "no data"}`);
          }
          const buf = Buffer.from(await dl.arrayBuffer());
          if (buf.length > 20 * 1024 * 1024) {
            throw new Error(`za duzy plik (${(buf.length / 1024 / 1024).toFixed(1)}MB > 20MB)`);
          }
          const base64 = buf.toString("base64");
          const mime = doc.mime_type || "application/pdf";

          const kind = doc.kind ?? "other";
          const sys = "Jesteś asystentem analizującym dokumenty techniczne dla generatora instrukcji obsługi smartwatchy Locon. Streszczasz pliki referencyjne w 1-3 zdaniach po POLSKU. Wyciągaj konkretne wartości techniczne (np. SAR head/body w W/kg, normy, częstotliwości, IP rating, pojemność baterii, wymiary). Bez fence, bez prozy poza treścią.";
          const usr = `Streść zawartość załączonego pliku ${
            kind === "sar_report" ? "(raport SAR)"
            : kind === "tech_spec" ? "(specyfikacja techniczna)"
            : kind === "manufacturer_manual" ? "(instrukcja producenta — może być w obcym języku, przetłumacz kluczowe terminy)"
            : kind === "declaration_ce" ? "(deklaracja zgodności CE)"
            : ""
          } w 1-3 zdaniach. Skup się na konkretnych wartościach które przydadzą się w generowaniu instrukcji obsługi modelu PL.`;

          const docStartedAt = Date.now();
          const ai = await callGeminiWithRetry({
            system: sys,
            user: usr,
            model: GEMINI_FLASH,
            maxTokens: 2000,
            inlineFiles: [{ mimeType: mime, data: base64 }],
          });

          const summary = ai.text.trim().slice(0, 2000);
          await sb
            .from("gen4_reference_docs")
            .update({ extracted_summary: summary })
            .eq("id", doc.id);

          void logAiCall({
            project_id: projectId,
            endpoint: "reference-docs/resummarize-all",
            context_type: "project",
            user_instruction: `bulk resummarize ${doc.name}`,
            system_prompt: sys,
            user_prompt: usr,
            model: ai.model,
            max_tokens: 2000,
            response_text: ai.text,
            tokens_in: ai.inputTokens,
            tokens_out: ai.outputTokens,
            duration_ms: Date.now() - docStartedAt,
            user_email: auth.email,
          });

          okCount++;
          send("progress", {
            current: i + 1,
            total: allDocs.length,
            doc_name: doc.name,
            status: "done",
            summary: summary.slice(0, 200),
            tokens_in: ai.inputTokens,
            tokens_out: ai.outputTokens,
          });
        } catch (err) {
          errCount++;
          const msg = err instanceof Error ? err.message : String(err);
          errors.push({ doc_id: doc.id, name: doc.name, error: msg.slice(0, 300) });
          send("progress", {
            current: i + 1,
            total: allDocs.length,
            doc_name: doc.name,
            status: "error",
            error: msg.slice(0, 300),
          });
        }
      }

      clearInterval(heartbeat);
      send("done", {
        total: allDocs.length,
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
