import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { callClaude, EDIT_MODEL } from "@/lib/anthropic";
import {
  ownPage,
  buildPageEditPrompt,
  parsePageEditResponse,
} from "@/lib/v4Edit";
import { loadReferenceDocs, getAttachmentFileIds } from "@/lib/v4ReferenceDocs";
import { loadProjectImagesForAi, getImageAttachmentFileIds, renderImagesGalleryForPrompt } from "@/lib/v4Images";
import { logAiCall } from "@/lib/v4AiLog";

export const runtime = "nodejs";
export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ pageId: string }>;
}

/** Generuje 2 alternatywne wersje strony (różne temperature) i zwraca obie
 *  bez zapisywania w bazie. Frontend pokazuje porównanie side-by-side i
 *  woła replace-elements dla wybranej wersji. */
export async function POST(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { pageId } = await ctx.params;
  if (!(await ownPage(pageId, auth.email))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const body = (await request.json().catch(() => null)) as { instruction?: string } | null;
  const instruction = body?.instruction?.trim();
  if (!instruction) {
    return NextResponse.json({ error: "missing instruction" }, { status: 400 });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "ANTHROPIC_API_KEY nie skonfigurowany" }, { status: 503 });
  }

  const built = await buildPageEditPrompt(pageId, instruction);
  if (!built) return NextResponse.json({ error: "page not found" }, { status: 404 });

  const sb = getSupabaseAdmin();
  const { data: pageMeta } = await sb
    .from("gen4_pages")
    .select("project_id, page_number")
    .eq("id", pageId)
    .single();
  const refDocs = pageMeta ? await loadReferenceDocs(pageMeta.project_id) : [];
  const galleryImages = pageMeta ? await loadProjectImagesForAi(pageMeta.project_id) : [];
  // Anthropic 5MB request limit — zero attachments, patrz auto-populate.
  const attachments: string[] = [];
  const galleryBlock = renderImagesGalleryForPrompt(galleryImages);
  const systemPrompt = galleryBlock ? `${galleryBlock}\n\n${built.system}` : built.system;

  // Generujemy obie wersje równolegle — caching system prompt sprawia że
  // druga jest 90% tańsza (cache_read).
  try {
    const [aiA, aiB] = await Promise.all([
      callClaude({
        system: systemPrompt,
        user: built.user,
        model: EDIT_MODEL,
        maxTokens: 4000,
        attachments: attachments.length > 0 ? attachments : undefined,
        cacheSystemPrompt: true,
        temperature: 0.7,
      }),
      callClaude({
        system: systemPrompt,
        user: built.user,
        model: EDIT_MODEL,
        maxTokens: 4000,
        attachments: attachments.length > 0 ? attachments : undefined,
        cacheSystemPrompt: true,
        temperature: 1.0,
      }),
    ]);

    const parsedA = parsePageEditResponse(aiA.text);
    const parsedB = parsePageEditResponse(aiB.text);

    // Pelna konwersacja per wariant — gen4_ai_calls. Dwa osobne wpisy zeby
    // mozna bylo porownac w panelu debug.
    if (pageMeta) {
      void logAiCall({
        project_id: pageMeta.project_id,
        page_id: pageId,
        endpoint: "ab-variants",
        context_type: "page",
        user_instruction: `${instruction} [variant A, temp 0.7]`,
        system_prompt: systemPrompt,
        user_prompt: built.user,
        model: aiA.model,
        temperature: 0.7,
        response_text: aiA.text,
        tokens_in: aiA.inputTokens,
        tokens_out: aiA.outputTokens,
        cache_creation_tokens: aiA.cacheCreationTokens ?? null,
        cache_read_tokens: aiA.cacheReadTokens ?? null,
        duration_ms: aiA.latencyMs,
        user_email: auth.email,
      });
      void logAiCall({
        project_id: pageMeta.project_id,
        page_id: pageId,
        endpoint: "ab-variants",
        context_type: "page",
        user_instruction: `${instruction} [variant B, temp 1.0]`,
        system_prompt: systemPrompt,
        user_prompt: built.user,
        model: aiB.model,
        temperature: 1.0,
        response_text: aiB.text,
        tokens_in: aiB.inputTokens,
        tokens_out: aiB.outputTokens,
        cache_creation_tokens: aiB.cacheCreationTokens ?? null,
        cache_read_tokens: aiB.cacheReadTokens ?? null,
        duration_ms: aiB.latencyMs,
        user_email: auth.email,
      });
    }

    // Telemetria
    if (pageMeta) {
      await sb.from("gen4_ai_history").insert({
        project_id: pageMeta.project_id,
        role: "assistant",
        content: `ab-variants page ${pageMeta.page_number}: 2 wersje (temp 0.7 vs 1.0)`,
        structured: {
          workflow_type: "ab_variants",
          page_id: pageId,
          page_number: pageMeta.page_number,
          instruction,
          cache_creation_tokens: (aiA.cacheCreationTokens ?? 0) + (aiB.cacheCreationTokens ?? 0),
          cache_read_tokens: (aiA.cacheReadTokens ?? 0) + (aiB.cacheReadTokens ?? 0),
        },
        model: aiA.model,
        input_tokens: aiA.inputTokens + aiB.inputTokens,
        output_tokens: aiA.outputTokens + aiB.outputTokens,
        latency_ms: Math.max(aiA.latencyMs, aiB.latencyMs),
      });
    }

    return NextResponse.json({
      ok: true,
      variant_a: {
        elements: parsedA.elements,
        temperature: 0.7,
        latency_ms: aiA.latencyMs,
      },
      variant_b: {
        elements: parsedB.elements,
        temperature: 1.0,
        latency_ms: aiB.latencyMs,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "AI call failed";
    if (pageMeta) {
      void logAiCall({
        project_id: pageMeta.project_id,
        page_id: pageId,
        endpoint: "ab-variants",
        context_type: "page",
        user_instruction: instruction,
        system_prompt: systemPrompt,
        user_prompt: built.user,
        model: EDIT_MODEL,
        max_tokens: 4000,
        error: msg,
        user_email: auth.email,
      });
    }
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
