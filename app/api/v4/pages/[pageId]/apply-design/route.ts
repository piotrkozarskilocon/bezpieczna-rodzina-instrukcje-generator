import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { callClaude, EDIT_MODEL, resolveModel } from "@/lib/anthropic";
import { ownPage, replacePageElements, loadPageWithElements } from "@/lib/v4Edit";
import { buildApplyDsToPagePrompt } from "@/lib/v4ApplyDs";
import { loadReferenceDocs, getAttachmentFileIds } from "@/lib/v4ReferenceDocs";
import { loadProjectImagesForAi, getImageAttachmentFileIds, renderImagesGalleryForPrompt } from "@/lib/v4Images";
import { logAiCall } from "@/lib/v4AiLog";
import { PageElementsPatchResponseSchema, type PageElementsPatchResponse, PageElementsResponseSchema, type PageElementsResponse } from "@/lib/v4Schemas";
import { applyPatch, type Operation } from "fast-json-patch";
import { validatePage, summarizeIssues, type ElementForValidation } from "@/lib/v4Validate";

export const runtime = "nodejs";
export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ pageId: string }>;
}

/**
 * Auto-tryb dla apply DS na pojedynczej stronie. Build prompt + callClaude
 * + replace w jednym wywołaniu. Frontend wywołuje to w pętli dla projektu
 * (po jednej stronie naraz, by zmieścić się w 60s Hobby).
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { pageId } = await ctx.params;
  if (!(await ownPage(pageId, auth.email))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const body = (await request.json().catch(() => null)) as
    | { ds_id?: string; instruction?: string; model?: string; custom_system?: string; custom_user?: string }
    | null;
  const dsId = body?.ds_id;
  if (!dsId) return NextResponse.json({ error: "missing ds_id" }, { status: 400 });
  const chosenModel = resolveModel(body?.model, EDIT_MODEL);

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY nie skonfigurowany — użyj trybu manualnego" },
      { status: 503 },
    );
  }

  const built = await buildApplyDsToPagePrompt(pageId, dsId, body?.instruction, { mode: "patches" });
  if (!built) return NextResponse.json({ error: "page or DS not found" }, { status: 404 });

  const sbForRef = getSupabaseAdmin();
  const { data: pageMeta } = await sbForRef
    .from("gen4_pages")
    .select("project_id")
    .eq("id", pageId)
    .single();
  const refDocs = pageMeta ? await loadReferenceDocs(pageMeta.project_id) : [];
  const galleryImages = pageMeta ? await loadProjectImagesForAi(pageMeta.project_id) : [];
  // Anthropic 5MB request limit: pelne PDF (27 files) + obrazki = 100+ MB → 413.
  // Tekst summary/structured z renderReferenceDocsForPrompt wystarczy zamiast PDF bytes.
  // Obrazki: tylko te z preferred_page_id == ta strona.
  const attachments = galleryImages
    .filter((img) => img.preferred_page_id === pageId)
    .map((img) => img.anthropic_file_id)
    .filter((id): id is string => !!id);

  const galleryBlock = renderImagesGalleryForPrompt(galleryImages);
  const baseSystem = body?.custom_system && body.custom_system.trim() ? body.custom_system : built.system;
  const systemPrompt = galleryBlock ? `${galleryBlock}\n\n${baseSystem}` : baseSystem;
  const userPrompt = body?.custom_user && body.custom_user.trim() ? body.custom_user : built.user;
  const promptEdited = !!(body?.custom_system || body?.custom_user);
  // Patches mode — output tokeny ~85% mniejsze niz pelna lista.
  const maxTokens = 6000;
  const startedAt = Date.now();
  const instructionDesc = body?.instruction?.trim() || `apply DS "${built.dsName}" to page ${built.pageNumber}`;
  const projectIdForLog = pageMeta?.project_id ?? null;

  try {
    const ai = await callClaude<PageElementsPatchResponse>({
      system: systemPrompt,
      user: userPrompt,
      model: chosenModel,
      maxTokens,
      attachments: attachments.length > 0 ? attachments : undefined,
      // Caching — w pętli apply-DS per page (typowo 14× w wizardzie 'Zastosuj DS
      // do projektu') system prompt jest identyczny (DS content + notes + ref).
      // Pierwsze wywołanie tworzy cache, kolejne 13 ~10% kosztu input.
      cacheSystemPrompt: true,
      outputSchema: {
        name: "submit_page_patches",
        description: "Submit RFC 6902 JSON Patch operations on document {elements:[...]} for the applied design system.",
        schema: PageElementsPatchResponseSchema,
      },
    });
    if (!ai.parsed) {
      throw new Error("AI did not return structured output");
    }
    const patches = (ai.parsed.patches ?? []) as Operation[];
    if (patches.length === 0) {
      throw new Error("AI returned 0 patches (no changes proposed for design system)");
    }
    // Apply RFC 6902 patches na biezacy stan strony.
    const currentDoc = { elements: built.elements.map((e: Record<string, unknown>) => ({
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
      const result = applyPatch(currentDoc, patches, true, false);
      newElements = (result.newDocument as { elements: unknown[] }).elements;
    } catch (patchErr) {
      const patchMsg = patchErr instanceof Error ? patchErr.message : "patch apply failed";
      console.warn(`[apply-design] applyPatch failed: ${patchMsg}, fallback do full mode. patches=`, JSON.stringify(patches).slice(0, 500));

      // FALLBACK do full mode — AI dostaje ten sam DS + state, ale ma zwrocic
      // pelna liste elementow zamiast patches. Tracimy 85% token savings dla
      // tej strony ale generujemy poprawnie. Strony ktore patches mode dziala
      // poprawnie (zwykle 50-70%) nadal korzystaja z redukcji.
      const builtFull = await buildApplyDsToPagePrompt(pageId, dsId, body?.instruction, { mode: "full" });
      if (!builtFull) {
        throw new Error(`AI returned invalid patches: ${patchMsg}; fallback build failed`);
      }
      const systemPromptFull = body?.custom_system?.trim() ? body.custom_system : builtFull.system;
      const userPromptFull = body?.custom_user?.trim() ? body.custom_user : builtFull.user;
      const aiFull = await callClaude<PageElementsResponse>({
        system: systemPromptFull,
        user: userPromptFull,
        model: chosenModel,
        maxTokens: 12000, // pelna lista potrzebuje wiecej output
        attachments: attachments.length > 0 ? attachments : undefined,
        cacheSystemPrompt: true,
        outputSchema: {
          name: "submit_page_elements",
          description: "Submit complete new list of elements for this page (fallback after patches mode failed).",
          schema: PageElementsResponseSchema,
        },
      });
      if (!aiFull.parsed) {
        throw new Error(`AI returned invalid patches: ${patchMsg}; full fallback also failed`);
      }
      newElements = aiFull.parsed.elements;
      fallbackUsed = true;
      console.log(`[apply-design] full mode fallback OK, ${newElements.length} elements`);
    }
    // SNAPSHOT przed replace — do rollback gdyby walidacja wykryla wiecej niz
    // 3 errors albo wiecej niz 8 issues lacznie. Snapshot to currentDoc.elements
    // (czysty stan strony przed apply DS).
    const snapshotElements = currentDoc.elements;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const count = await replacePageElements(pageId, { elements: newElements as any });

    // POST-APPLY VALIDATION — fetch swiezo zapisanej strony i sprawdz czy
    // AI nie zniszczyl layoutu. Trigger rollback gdy:
    //   - errors > 3 (powaznie poza strona)
    //   - errors + warnings > 8 (totalna masakra)
    let rolledBack = false;
    let validationSummary: ReturnType<typeof summarizeIssues> | null = null;
    let rollbackReason: string | null = null;
    try {
      const fresh = await loadPageWithElements(pageId);
      if (fresh) {
        const elementsForVal: ElementForValidation[] = fresh.elements.map((e) => ({
          id: e.id,
          type: e.type,
          x_mm: e.x_mm,
          y_mm: e.y_mm,
          w_mm: e.w_mm,
          h_mm: e.h_mm,
          properties: e.properties,
        }));
        const issues = validatePage({
          id: fresh.page.id,
          page_number: fresh.page.page_number,
          width_mm: fresh.page.width_mm,
          height_mm: fresh.page.height_mm,
          template: fresh.page.template,
          title: fresh.page.title,
          elements: elementsForVal,
        });
        validationSummary = summarizeIssues(issues);
        if (validationSummary.errors > 3 || validationSummary.errors + validationSummary.warnings > 8) {
          rollbackReason = `validation: ${validationSummary.errors} errors + ${validationSummary.warnings} warnings (limit: 3 err / 8 total)`;
          console.warn(`[apply-design] AUTO-ROLLBACK pageId=${pageId} powod: ${rollbackReason}`);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await replacePageElements(pageId, { elements: snapshotElements as any });
          rolledBack = true;
        }
      }
    } catch (valErr) {
      const m = valErr instanceof Error ? valErr.message : "validation failed";
      console.warn(`[apply-design] validation step failed (nieblokujace): ${m}`);
    }

    if (projectIdForLog) {
      void logAiCall({
        project_id: projectIdForLog,
        page_id: pageId,
        endpoint: "apply-design",
        context_type: "page",
        user_instruction: instructionDesc,
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

    return NextResponse.json({
      ok: true,
      page_id: pageId,
      page_number: built.pageNumber,
      elements: rolledBack ? snapshotElements.length : count,
      fallback_used: fallbackUsed,
      rolled_back: rolledBack,
      rollback_reason: rollbackReason,
      validation: validationSummary,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "AI call failed";
    if (projectIdForLog) {
      void logAiCall({
        project_id: projectIdForLog,
        page_id: pageId,
        endpoint: "apply-design",
        context_type: "page",
        user_instruction: instructionDesc,
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
