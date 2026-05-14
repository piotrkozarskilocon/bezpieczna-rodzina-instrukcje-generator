import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { callClaudeStream, EDIT_MODEL, resolveModel } from "@/lib/anthropic";
import {
  ownPage,
  buildPageEditPrompt,
  parsePageEditResponse,
  replacePageElements,
} from "@/lib/v4Edit";
import { loadReferenceDocs, getAttachmentFileIds } from "@/lib/v4ReferenceDocs";
import { loadProjectImagesForAi, getImageAttachmentFileIds, renderImagesGalleryForPrompt } from "@/lib/v4Images";
import { logAiCall } from "@/lib/v4AiLog";

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

  const body = (await request.json().catch(() => null)) as
    | { instruction?: string; model?: string; custom_system?: string; custom_user?: string }
    | null;
  const instruction = body?.instruction?.trim();
  const chosenModel = resolveModel(body?.model, EDIT_MODEL);
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
  const galleryImages = pageMeta ? await loadProjectImagesForAi(pageMeta.project_id) : [];
  const attachments = [...getAttachmentFileIds(refDocs), ...getImageAttachmentFileIds(galleryImages)];

  const galleryBlock = renderImagesGalleryForPrompt(galleryImages);
  const baseSystem = body?.custom_system && body.custom_system.trim() ? body.custom_system : built.system;
  const systemPrompt = galleryBlock ? `${galleryBlock}\n\n${baseSystem}` : baseSystem;
  const userPrompt = body?.custom_user && body.custom_user.trim() ? body.custom_user : built.user;
  const promptEdited = !!(body?.custom_system || body?.custom_user);

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
      const startedAt = Date.now();
      const maxTokens = 12000;
      try {
        const ai = await callClaudeStream(
          {
            system: systemPrompt,
            user: userPrompt,
            model: chosenModel,
            maxTokens, // strony z 20+ elementami potrzebują wiecej; truncation = JSON parse fail
            attachments: attachments.length > 0 ? attachments : undefined,
            cacheSystemPrompt: true,
          },
          (delta) => emit(controller, { type: "delta", text: delta }),
        );
        // Parse + apply
        const parsed = parsePageEditResponse(ai.text);
        const count = await replacePageElements(pageId, parsed);
        // Debug log + telemetria
        if (pageMeta) {
          void logAiCall({
            project_id: pageMeta.project_id,
            page_id: pageId,
            endpoint: "ai-edit-stream",
            context_type: "page",
            user_instruction: instruction,
            system_prompt: systemPrompt,
            user_prompt: userPrompt,
            prompt_edited_by_user: promptEdited,
            model: chosenModel,
            max_tokens: maxTokens,
            response_text: ai.text,
            tokens_in: ai.inputTokens,
            tokens_out: ai.outputTokens,
            cache_creation_tokens: ai.cacheCreationTokens ?? null,
            cache_read_tokens: ai.cacheReadTokens ?? null,
            duration_ms: Date.now() - startedAt,
            user_email: auth.email,
          });
        }
        emit(controller, { type: "done", elements: count, latency_ms: ai.latencyMs });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "stream failed";
        if (pageMeta) {
          void logAiCall({
            project_id: pageMeta.project_id,
            page_id: pageId,
            endpoint: "ai-edit-stream",
            context_type: "page",
            user_instruction: instruction,
            system_prompt: systemPrompt,
            user_prompt: userPrompt,
            prompt_edited_by_user: promptEdited,
            model: chosenModel,
            max_tokens: maxTokens,
            error: msg,
            duration_ms: Date.now() - startedAt,
            user_email: auth.email,
          });
        }
        emit(controller, { type: "error", error: msg });
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
