import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { callClaudeStream, EDIT_MODEL } from "@/lib/anthropic";
import {
  ownPage,
  buildPageEditPrompt,
  parsePageEditResponse,
  replacePageElements,
} from "@/lib/v4Edit";
import { loadReferenceDocs, getAttachmentFileIds } from "@/lib/v4ReferenceDocs";

export const runtime = "nodejs";
export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ pageId: string }>;
}

/**
 * Streamujący wariant ai-edit. Wysyła JSON-lines events:
 *   {"type":"delta","text":"..."} — fragment tekstu AI
 *   {"type":"done","elements":N}  — koniec, ile elementów zostało wstawionych
 *   {"type":"error","error":"..."} — błąd
 *
 * Frontend czyta przez fetch().body.getReader() i wyświetla progress live.
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { pageId } = await ctx.params;
  if (!(await ownPage(pageId, auth.email))) {
    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const body = (await request.json().catch(() => null)) as { instruction?: string } | null;
  const instruction = body?.instruction?.trim();
  if (!instruction) {
    return new Response(JSON.stringify({ error: "missing instruction" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY nie skonfigurowany" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }

  const built = await buildPageEditPrompt(pageId, instruction);
  if (!built) {
    return new Response(JSON.stringify({ error: "page not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const sb = getSupabaseAdmin();
  const { data: pageMeta } = await sb
    .from("gen4_pages")
    .select("project_id, page_number, template")
    .eq("id", pageId)
    .single();
  const refDocs = pageMeta ? await loadReferenceDocs(pageMeta.project_id) : [];
  const attachments = getAttachmentFileIds(refDocs);

  // Construct ReadableStream which:
  //  - kicks off Anthropic call in background
  //  - emits delta events as text chunks come in
  //  - parses + applies after finalMessage
  //  - emits done or error event
  const encoder = new TextEncoder();
  const emit = (controller: ReadableStreamDefaultController<Uint8Array>, obj: unknown) => {
    controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const ai = await callClaudeStream(
          {
            system: built.system,
            user: built.user,
            model: EDIT_MODEL,
            maxTokens: 12000, // strony z 20+ elementami potrzebują wiecej; truncation = JSON parse fail
            attachments: attachments.length > 0 ? attachments : undefined,
            cacheSystemPrompt: true,
          },
          (delta) => emit(controller, { type: "delta", text: delta }),
        );
        // Parse + apply
        const parsed = parsePageEditResponse(ai.text);
        const count = await replacePageElements(pageId, parsed);
        // Telemetria
        if (pageMeta) {
          await sb.from("gen4_ai_history").insert({
            project_id: pageMeta.project_id,
            role: "assistant",
            content: `ai-edit-stream page ${pageMeta.page_number}: ${instruction.slice(0, 200)}`,
            structured: {
              workflow_type: "ai_edit_stream",
              page_id: pageId,
              page_number: pageMeta.page_number,
              template: pageMeta.template,
              instruction,
              elements_count: count,
              cache_creation_tokens: ai.cacheCreationTokens,
              cache_read_tokens: ai.cacheReadTokens,
            },
            model: ai.model,
            input_tokens: ai.inputTokens,
            output_tokens: ai.outputTokens,
            latency_ms: ai.latencyMs,
          });
        }
        emit(controller, { type: "done", elements: count, latency_ms: ai.latencyMs });
      } catch (err) {
        emit(controller, { type: "error", error: err instanceof Error ? err.message : "stream failed" });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no", // disable nginx buffering on Vercel
    },
  });
}
