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
import { prepareFileForAi } from "@/lib/v4FileExtract";
import { countPdfPages, chunkPdf, MAX_PAGES_PER_CHUNK } from "@/lib/v4PdfChunk";

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
  extracted_summary: string | null;
}

/** Heurystyka: czy summary jest "broken" tj. AI mowi ze nie widzi pliku.
 *  Po fix Anthropic Files → Supabase Storage te frazy zniknely. */
function isBrokenSummary(s: string | null): boolean {
  if (!s) return true;
  const lc = s.toLowerCase();
  return (
    lc.includes("nie widz") ||
    lc.includes("nie mam dostępu") ||
    lc.includes("czekam na plik") ||
    lc.includes("i notice you") ||
    lc.includes("załączonego pliku") ||
    lc.includes("oczekuję na zawartość") ||
    lc.includes("nie zobaczyłem") ||
    lc.includes("brakuje załączonego") ||
    lc.includes("brak załączonego")
  );
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

  // Param ?force=1 (default = idempotent, pomijamy pliki z fresh summary).
  const force = new URL(request.url).searchParams.get("force") === "1";

  const { data: docs } = await sb
    .from("gen4_reference_docs")
    .select("id, kind, name, file_path, mime_type, extracted_summary")
    .eq("project_id", projectId)
    .order("created_at", { ascending: true });
  const docsAll = (docs ?? []) as DocRow[];
  // Idempotency: skip pliki ktore juz maja sensowne summary (po fix Anthropic
  // Files → Supabase Storage). User moze wymusic force=1 zeby zregenerowac wszystko.
  const skippedDocs = force ? [] : docsAll.filter((d) => !isBrokenSummary(d.extracted_summary));
  const allDocs = force ? docsAll : docsAll.filter((d) => isBrokenSummary(d.extracted_summary));

  if (allDocs.length === 0) {
    return new Response(JSON.stringify({
      error: `Brak plikow do resummarize (${skippedDocs.length} juz ma fresh summary). Uzyj ?force=1 zeby zregenerowac wszystkie.`,
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
        total: allDocs.length,
        project_id: projectId,
        skipped: skippedDocs.length,
        skipped_note: skippedDocs.length > 0 ? `Pominieto ${skippedDocs.length} plikow z fresh summary` : null,
      });

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
          let buf = Buffer.from(await dl.arrayBuffer());
          let mime = doc.mime_type || "application/pdf";

          // Gemini nie obsluguje DOCX/XLSX inline. prepareFileForAi konwertuje
          // DOCX -> tekst i XLSX -> CSV (lokalnie po stronie serwera).
          if (mime.includes("officedocument") || mime.includes("opendocument")) {
            const prepared = await prepareFileForAi(buf, doc.name, mime);
            buf = Buffer.from(prepared.bytes);
            mime = prepared.mimeType;
          }
          const kind = doc.kind ?? "other";
          const sys = "Jesteś asystentem analizującym dokumenty techniczne dla generatora instrukcji obsługi smartwatchy Locon. Streszczasz pliki referencyjne w 1-3 zdaniach po POLSKU. Wyciągaj konkretne wartości techniczne (np. SAR head/body w W/kg, normy, częstotliwości, IP rating, pojemność baterii, wymiary). Bez fence, bez prozy poza treścią.";
          const kindLabel = kind === "sar_report" ? "(raport SAR)"
            : kind === "tech_spec" ? "(specyfikacja techniczna)"
            : kind === "manufacturer_manual" ? "(instrukcja producenta — może być w obcym języku, przetłumacz kluczowe terminy)"
            : kind === "declaration_ce" ? "(deklaracja zgodności CE)"
            : "";

          const docStartedAt = Date.now();

          // PDF chunking dla wielostronicowych plikow (> MAX_PAGES_PER_CHUNK).
          // Gemini ma limit 1000 stron / ~1M tokenow. Anthropic ma 100 stron.
          // Bezpieczna granica: 400 stron na chunk. Per chunk osobne summary,
          // potem agregat z prefixem 'Strony N-M:'.
          let summary: string;
          let totalIn = 0;
          let totalOut = 0;

          const isPdf = mime === "application/pdf";
          const pageCount = isPdf ? await countPdfPages(buf).catch(() => 0) : 0;

          if (isPdf && pageCount > MAX_PAGES_PER_CHUNK) {
            send("progress", {
              current: i + 1,
              total: allDocs.length,
              doc_name: doc.name,
              status: "chunking",
              pages: pageCount,
            });
            const chunks = await chunkPdf(buf, MAX_PAGES_PER_CHUNK);
            const partials: string[] = [];
            for (let c = 0; c < chunks.length; c++) {
              const chunk = chunks[c];
              send("progress", {
                current: i + 1,
                total: allDocs.length,
                doc_name: doc.name,
                status: "chunk",
                chunk_index: c + 1,
                chunk_total: chunks.length,
                chunk_pages: `${chunk.startPage}-${chunk.endPage}`,
              });
              const chunkBase64 = chunk.bytes.toString("base64");
              const chunkUser = `Streść zawartość załączonego fragmentu pliku ${kindLabel} (strony ${chunk.startPage}-${chunk.endPage} z ${pageCount}) w 1-3 zdaniach. Skup się na konkretnych wartościach które przydadzą się w generowaniu instrukcji obsługi modelu PL.`;
              const chunkAi = await callGeminiWithRetry({
                system: sys,
                user: chunkUser,
                model: GEMINI_FLASH,
                maxTokens: 1000,
                inlineFiles: [{ mimeType: "application/pdf", data: chunkBase64 }],
              });
              partials.push(`Strony ${chunk.startPage}-${chunk.endPage}: ${chunkAi.text.trim()}`);
              totalIn += chunkAi.inputTokens;
              totalOut += chunkAi.outputTokens;
            }
            summary = partials.join("\n\n").slice(0, 2000);
          } else {
            if (buf.length > 20 * 1024 * 1024) {
              throw new Error(`za duzy plik (${(buf.length / 1024 / 1024).toFixed(1)}MB > 20MB)`);
            }
            const base64 = buf.toString("base64");
            const usr = `Streść zawartość załączonego pliku ${kindLabel} w 1-3 zdaniach. Skup się na konkretnych wartościach które przydadzą się w generowaniu instrukcji obsługi modelu PL.`;
            const ai = await callGeminiWithRetry({
              system: sys,
              user: usr,
              model: GEMINI_FLASH,
              maxTokens: 2000,
              inlineFiles: [{ mimeType: mime, data: base64 }],
            });
            summary = ai.text.trim().slice(0, 2000);
            totalIn = ai.inputTokens;
            totalOut = ai.outputTokens;
          }

          await sb
            .from("gen4_reference_docs")
            .update({ extracted_summary: summary })
            .eq("id", doc.id);

          void logAiCall({
            project_id: projectId,
            endpoint: "reference-docs/resummarize-all",
            context_type: "project",
            user_instruction: `bulk resummarize ${doc.name}${pageCount > MAX_PAGES_PER_CHUNK ? ` (chunked, ${pageCount} pages)` : ""}`,
            system_prompt: sys,
            user_prompt: pageCount > MAX_PAGES_PER_CHUNK ? `[chunked, ${pageCount} pages]` : "(single call)",
            model: GEMINI_FLASH,
            max_tokens: 2000,
            response_text: summary,
            tokens_in: totalIn,
            tokens_out: totalOut,
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
            tokens_in: totalIn,
            tokens_out: totalOut,
            chunks: pageCount > MAX_PAGES_PER_CHUNK ? Math.ceil(pageCount / MAX_PAGES_PER_CHUNK) : 1,
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
