import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { callClaude, EDIT_MODEL, resolveModel } from "@/lib/anthropic";
import {
  ownPage,
  buildPageEditPrompt,
  replacePageElements,
} from "@/lib/v4Edit";
import { loadReferenceDocs, getAttachmentFileIds } from "@/lib/v4ReferenceDocs";
import { loadProjectImagesForAi, getImageAttachmentFileIds, renderImagesGalleryForPrompt } from "@/lib/v4Images";
import { logAiCall } from "@/lib/v4AiLog";
import { PageElementsPatchResponseSchema, type PageElementsPatchResponse, PageElementsResponseSchema, type PageElementsResponse } from "@/lib/v4Schemas";
import { applyPatch, type Operation } from "fast-json-patch";

export const runtime = "nodejs";
export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ pageId: string }>;
}

/**
 * Auto-tryb dla Assistant AI w editorze: jedno kliknięcie, AI wykonuje
 * polecenie i zapisuje wynik. Manualne endpointy /edit-prompt + /replace-elements
 * zostają dla fallbacku gdy klucza API nie ma.
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { pageId } = await ctx.params;
  if (!(await ownPage(pageId, auth.email))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const body = (await request.json().catch(() => null)) as
    | {
        instruction?: string;
        skip_attachments?: boolean;
        layout_only?: boolean;
        model?: string;
        custom_system?: string;
        custom_user?: string;
      }
    | null;
  const instruction = body?.instruction?.trim();
  if (!instruction) {
    return NextResponse.json({ error: "missing instruction" }, { status: 400 });
  }
  // layout_only / skip_attachments — pomijamy PDF reference docs gdy
  // operacja jest geometryczna (np. 'Napraw przez AI' z walidacji layoutu).
  // Bez tego Claude czyta wszystkie PDF (SAR + spec + chińska instrukcja) i
  // wywołanie przekracza 60s Vercel cap → 502/504.
  const skipAttachments = body?.skip_attachments === true || body?.layout_only === true;
  const chosenModel = resolveModel(body?.model, EDIT_MODEL);

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY nie skonfigurowany — użyj trybu manualnego" },
      { status: 503 },
    );
  }

  const built = await buildPageEditPrompt(pageId, instruction, { mode: "patches" });
  if (!built) return NextResponse.json({ error: "page not found" }, { status: 404 });

  const sb = getSupabaseAdmin();
  const { data: pageMeta } = await sb
    .from("gen4_pages")
    .select("project_id")
    .eq("id", pageId)
    .single();
  const refDocs = pageMeta && !skipAttachments ? await loadReferenceDocs(pageMeta.project_id) : [];
  // Gallery images zawsze (jesli sa) — sa lekkie i czesto potrzebne do user-
  // visible operacji. skip_attachments dotyczy tylko duzych ref docs (PDF SAR).
  const galleryImages = pageMeta ? await loadProjectImagesForAi(pageMeta.project_id) : [];
  // Anthropic 5MB request limit. Zero attachments — PDF jako tekst, obrazki
  // po image_id z opisu. Patrz auto-populate komentarz.
  const attachments: string[] = [];

  // Override promptu przez usera (debug "Edytuj prompt przed uruchomieniem").
  const galleryBlock = renderImagesGalleryForPrompt(galleryImages);
  const baseSystem = body?.custom_system && body.custom_system.trim() ? body.custom_system : built.system;
  const systemPrompt = galleryBlock ? `${galleryBlock}\n\n${baseSystem}` : baseSystem;
  const userPrompt = body?.custom_user && body.custom_user.trim() ? body.custom_user : built.user;
  const promptEdited = !!(body?.custom_system || body?.custom_user);

  // Patches output schema — output tokeny ~85% mniejsze niz pelna lista.
  const maxTokens = skipAttachments ? 3000 : 6000;
  const startedAt = Date.now();
  try {
    const ai = await callClaude<PageElementsPatchResponse>({
      system: systemPrompt,
      user: userPrompt,
      model: chosenModel,
      maxTokens,
      attachments: attachments.length > 0 ? attachments : undefined,
      cacheSystemPrompt: true,
      outputSchema: {
        name: "submit_page_patches",
        description: "Submit RFC 6902 JSON Patch operations on document {elements:[...]}.",
        schema: PageElementsPatchResponseSchema,
      },
    });
    if (!ai.parsed) {
      throw new Error("AI did not return structured output");
    }

    // Apply RFC 6902 patches na biezacy stan strony. Mutate=false zeby zachowac
    // oryginal jako fallback do logu.
    const patches = (ai.parsed.patches ?? []) as Operation[];
    if (patches.length === 0) {
      // AI poprawnie zdecydowal ze nie ma co zmieniac — no-op success, nie blad.
      // (zdarza sie przy bulk batch-edit gdy strona juz jest OK)
      return NextResponse.json({
        ok: true,
        page_id: pageId,
        elements: built.elements.length,
        no_op: true,
        reason: "AI did not propose any changes (page already OK)",
      });
    }
    const currentDoc = { elements: built.elements.map((e) => ({
      type: e.type,
      x_mm: e.x_mm,
      y_mm: e.y_mm,
      w_mm: e.w_mm,
      h_mm: e.h_mm,
      z_index: e.z_index,
      rotation_deg: e.rotation_deg,
      properties: e.properties,
    })) };
    let newElements;
    let fallbackUsed = false;
    try {
      const result = applyPatch(currentDoc, patches, /* validate */ true, /* mutate */ false);
      newElements = (result.newDocument as { elements: unknown[] }).elements;
    } catch (patchErr) {
      const patchMsg = patchErr instanceof Error ? patchErr.message : "patch apply failed";
      console.warn(`[ai-edit] applyPatch failed: ${patchMsg}, fallback do full mode. patches=`, JSON.stringify(patches).slice(0, 500));

      // FALLBACK do full mode — analogicznie do apply-design route.
      const builtFull = await buildPageEditPrompt(pageId, instruction, { mode: "full" });
      if (!builtFull) {
        throw new Error(`AI returned invalid patches: ${patchMsg}; full fallback build failed`);
      }
      const systemPromptFull = body?.custom_system?.trim() ? body.custom_system : builtFull.system;
      const userPromptFull = body?.custom_user?.trim() ? body.custom_user : builtFull.user;
      const aiFull = await callClaude<PageElementsResponse>({
        system: systemPromptFull,
        user: userPromptFull,
        model: chosenModel,
        maxTokens: 12000,
        attachments: attachments.length > 0 ? attachments : undefined,
        cacheSystemPrompt: true,
        outputSchema: {
          name: "submit_page_elements",
          description: "Submit complete new list of elements (fallback after patches mode failed).",
          schema: PageElementsResponseSchema,
        },
      });
      if (!aiFull.parsed) {
        throw new Error(`AI returned invalid patches: ${patchMsg}; full fallback also failed`);
      }
      newElements = aiFull.parsed.elements;
      fallbackUsed = true;
      console.log(`[ai-edit] full fallback OK, ${newElements.length} elements`);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const count = await replacePageElements(pageId, { elements: newElements as any });

    // Debug log — zapisz dokladnie co poszlo do AI i co wrocilo.
    if (pageMeta) {
      void logAiCall({
        project_id: pageMeta.project_id,
        page_id: pageId,
        endpoint: "ai-edit",
        context_type: "page",
        user_instruction: instruction,
        system_prompt: systemPrompt,
        user_prompt: userPrompt,
        prompt_edited_by_user: promptEdited,
        model: chosenModel,
        max_tokens: maxTokens,
        response_text: ai.text || JSON.stringify(ai.parsed ?? ai.rawToolInput ?? null),
        tokens_in: ai.inputTokens,
        tokens_out: ai.outputTokens,
        cache_creation_tokens: ai.cacheCreationTokens ?? null,
        cache_read_tokens: ai.cacheReadTokens ?? null,
        duration_ms: Date.now() - startedAt,
        user_email: auth.email,
      });
    }

    const { data: page } = await sb
      .from("gen4_pages")
      .select("project_id, page_number, template")
      .eq("id", pageId)
      .single();
    if (page) {
      await sb.from("gen4_ai_history").insert({
        project_id: page.project_id,
        role: "assistant",
        content: `ai-edit page ${page.page_number}: ${instruction.slice(0, 200)}`,
        structured: {
          workflow_type: "ai_edit",
          page_id: pageId,
          page_number: page.page_number,
          template: page.template,
          instruction,
          elements_count: count,
        },
        model: ai.model,
        input_tokens: ai.inputTokens,
        output_tokens: ai.outputTokens,
        latency_ms: ai.latencyMs,
      });
    }

    return NextResponse.json({ ok: true, elements: count, fallback_used: fallbackUsed });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "AI call failed";
    // Loguj tez bledy — czesto najwazniejsze do debugu (parse fail, timeout itd.).
    if (pageMeta) {
      void logAiCall({
        project_id: pageMeta.project_id,
        page_id: pageId,
        endpoint: "ai-edit",
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
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
