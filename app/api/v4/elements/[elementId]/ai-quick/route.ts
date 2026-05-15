/**
 * AI Quick Actions na pojedynczym text/callout elemencie.
 *
 * POST /api/v4/elements/[elementId]/ai-quick
 * Body: { action: 'shorten' | 'expand' | 'fix-grammar' | 'translate', target_lang?: string }
 *
 * Modyfikuje tylko `properties.content` (lub `properties.content_<lang>` dla translate)
 * przez krótki, deterministyczny prompt do Claude Haiku. Zwraca nowy content.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { callClaude, EDIT_MODEL } from "@/lib/anthropic";
import { logAiCall } from "@/lib/v4AiLog";

export const runtime = "nodejs";
export const maxDuration = 30;

interface RouteContext {
  params: Promise<{ elementId: string }>;
}

const ACTIONS = new Set(["shorten", "expand", "fix-grammar", "translate", "improve", "simplify"]);

async function ownElement(
  sb: ReturnType<typeof getSupabaseAdmin>,
  elementId: string,
  email: string,
): Promise<{ ownerOk: boolean; pageId?: string; projectId?: string }> {
  const { data: el } = await sb
    .from("gen4_elements")
    .select("page_id, type, properties")
    .eq("id", elementId)
    .single();
  if (!el) return { ownerOk: false };
  const { data: page } = await sb
    .from("gen4_pages")
    .select("project_id")
    .eq("id", el.page_id)
    .single();
  if (!page) return { ownerOk: false };
  const { data: project } = await sb
    .from("gen4_projects")
    .select("owner_email")
    .eq("id", page.project_id)
    .single();
  return {
    ownerOk: project?.owner_email === email,
    pageId: el.page_id,
    projectId: page.project_id,
  };
}

export async function POST(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "ANTHROPIC_API_KEY not configured" }, { status: 503 });
  }

  const { elementId } = await ctx.params;
  const sb = getSupabaseAdmin();
  const ownership = await ownElement(sb, elementId, auth.email);
  if (!ownership.ownerOk) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = (await request.json().catch(() => null)) as { action?: string; target_lang?: string } | null;
  const action = body?.action;
  if (!action || !ACTIONS.has(action)) {
    return NextResponse.json({ error: `invalid action (allowed: ${Array.from(ACTIONS).join(", ")})` }, { status: 400 });
  }

  const { data: el } = await sb
    .from("gen4_elements")
    .select("type, properties")
    .eq("id", elementId)
    .single();
  if (!el) return NextResponse.json({ error: "element not found" }, { status: 404 });

  if (el.type !== "text" && el.type !== "callout") {
    return NextResponse.json({ error: `AI quick action dziala tylko na text/callout, nie ${el.type}` }, { status: 400 });
  }

  const currentContent = (el.properties as { content?: string })?.content;
  if (!currentContent || currentContent.trim().length === 0) {
    return NextResponse.json({ error: "element nie ma tresci do modyfikacji" }, { status: 400 });
  }

  const targetLang = body?.target_lang ?? "pl";
  let system: string;
  let userPrompt: string;
  switch (action) {
    case "shorten":
      system = "Skracaj tekst zachowujac sens, ale uzywajac mniej slow. Cel: ~50% oryginalnej dlugosci. Zwroc TYLKO skrocony tekst, bez komentarzy.";
      userPrompt = `Skroc ten tekst zachowujac sens i polskie znaki diakrytyczne:\n\n${currentContent}`;
      break;
    case "expand":
      system = "Rozszerzaj tekst dodajac szczegoly i przyklady, zachowujac sens. Cel: ~150% oryginalnej dlugosci. Zwroc TYLKO rozszerzony tekst.";
      userPrompt = `Rozszerz ten tekst dodajac szczegoly (zachowaj polski jezyk + diakrytyki):\n\n${currentContent}`;
      break;
    case "fix-grammar":
      system = "Popraw gramatyka, ortografie i interpunkcje. Zachowaj sens i dlugosc. Zwroc TYLKO poprawiony tekst.";
      userPrompt = `Popraw gramatyka/ortografie/interpunkcje w polskim tekscie (zachowaj diakrytyki):\n\n${currentContent}`;
      break;
    case "improve":
      system = "Popraw styl, plynnosc, czytelnosc tekstu. Zachowaj sens. Uzywaj prostego polskiego. Zwroc TYLKO ulepszony tekst.";
      userPrompt = `Popraw styl i czytelnosc tego polskiego tekstu (zachowaj diakrytyki):\n\n${currentContent}`;
      break;
    case "simplify":
      system = "Uprosc jezyk, uzyj prostszych slow, krotszych zdan. Cel: zrozumiala dla 10-latka. Zachowaj sens. Zwroc TYLKO uproszczony tekst.";
      userPrompt = `Uprosc jezyk tego tekstu (zachowaj polski + diakrytyki):\n\n${currentContent}`;
      break;
    case "translate": {
      const langName = {
        en: "angielski", bg: "bulgarski", hr: "chorwacki", ro: "rumunski",
        mk: "macedonski", sq: "albanski", pl: "polski",
      }[targetLang] ?? targetLang;
      system = `Tlumacz tekst na ${langName}. Zachowaj formatowanie i sens. Zwroc TYLKO przetlumaczony tekst, bez komentarzy.`;
      userPrompt = `Tlumacz na ${langName}:\n\n${currentContent}`;
      break;
    }
    default:
      return NextResponse.json({ error: "invalid action" }, { status: 400 });
  }

  const startedAt = Date.now();
  try {
    const ai = await callClaude({
      system,
      user: userPrompt,
      model: EDIT_MODEL,
      maxTokens: 2000,
    });
    let newContent = ai.text.trim();
    // Strip otaczajacych cudzyslowow jezeli AI je dodal.
    if ((newContent.startsWith('"') && newContent.endsWith('"')) ||
        (newContent.startsWith("'") && newContent.endsWith("'"))) {
      newContent = newContent.slice(1, -1);
    }

    // Update element. Dla translate zapisujemy do content_<lang>, dla pozostalych do content.
    const propKey = action === "translate" && targetLang !== "pl" ? `content_${targetLang}` : "content";
    const newProperties = { ...(el.properties as Record<string, unknown>), [propKey]: newContent };
    await sb
      .from("gen4_elements")
      .update({ properties: newProperties })
      .eq("id", elementId);

    void logAiCall({
      project_id: ownership.projectId ?? null,
      page_id: ownership.pageId ?? null,
      endpoint: `elements/ai-quick/${action}`,
      context_type: "element",
      user_instruction: `${action} on element ${elementId}`,
      system_prompt: system,
      user_prompt: userPrompt,
      model: ai.model,
      max_tokens: 2000,
      response_text: ai.text,
      tokens_in: ai.inputTokens,
      tokens_out: ai.outputTokens,
      duration_ms: Date.now() - startedAt,
      user_email: auth.email,
    });

    return NextResponse.json({
      ok: true,
      element_id: elementId,
      action,
      old_content: currentContent,
      new_content: newContent,
      property_key: propKey,
      tokens_in: ai.inputTokens,
      tokens_out: ai.outputTokens,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "AI call failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
