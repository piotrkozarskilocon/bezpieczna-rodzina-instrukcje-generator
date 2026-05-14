import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { callClaude, EDIT_MODEL } from "@/lib/anthropic";
import {
  buildTranslationPrompt,
  parseTranslationResponse,
  SUPPORTED_LANGS,
  type TargetLang,
} from "@/lib/v4Translate";
import {
  lookupTranslations,
  saveTranslations,
  incrementMemoryUseCount,
} from "@/lib/v4TranslationMemory";
import { logAiCall } from "@/lib/v4AiLog";

export const runtime = "nodejs";
export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Auto-tryb tłumaczeń. Workflow:
 *   1. Załaduj listę element_id → source_text z gen4_elements.
 *   2. Lookup w gen4_translation_memory (per owner+target_lang+hash).
 *      Cached → od razu w wyniku, bez wywołania AI.
 *   3. Tylko nie-cached idą do AI (1 wywołanie batch).
 *   4. Zapis nowych tłumaczeń do memory + upsert do gen4_translations.
 *
 * Body: { lang: "bg|hr|ro|mk|sq|en" }
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const sb = getSupabaseAdmin();
  const { data: project } = await sb
    .from("gen4_projects")
    .select("owner_email, default_lang")
    .eq("id", id)
    .single();
  if (!project || project.owner_email !== auth.email) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const body = (await request.json().catch(() => null)) as { lang?: string } | null;
  const lang = body?.lang?.toLowerCase();
  if (!lang || !(SUPPORTED_LANGS as readonly string[]).includes(lang)) {
    return NextResponse.json({ error: `unsupported lang: ${lang}` }, { status: 400 });
  }
  if (lang === project.default_lang) {
    return NextResponse.json({ error: "źródłowy = docelowy" }, { status: 400 });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "ANTHROPIC_API_KEY nie skonfigurowany" }, { status: 503 });
  }

  // 1+2. Pobierz teksty + lookup memory.
  const { data: pages } = await sb
    .from("gen4_pages")
    .select("id")
    .eq("project_id", id);
  const pageIds = (pages ?? []).map((p) => p.id);
  if (pageIds.length === 0) {
    return NextResponse.json({ error: "projekt nie ma stron" }, { status: 400 });
  }

  const { data: elements } = await sb
    .from("gen4_elements")
    .select("id, properties")
    .in("page_id", pageIds)
    .in("type", ["text", "callout"]);
  const sources: Array<{ id: string; text: string }> = [];
  for (const el of elements ?? []) {
    const content = (el.properties as Record<string, unknown> | null)?.content;
    if (typeof content === "string" && content.trim()) {
      sources.push({ id: el.id, text: content.trim() });
    }
  }
  if (sources.length === 0) {
    return NextResponse.json({ ok: true, translations: 0, cached: 0, fresh: 0 });
  }

  const memoryHits = await lookupTranslations(auth.email, lang as TargetLang, sources);
  const fromAi: Array<{ id: string; text: string }> = sources.filter((s) => !memoryHits.has(s.id));

  // 3. AI batch dla nie-cached.
  let aiTranslations = new Map<string, string>();
  let aiLog: Record<string, unknown> | null = null;
  if (fromAi.length > 0) {
    const built = await buildTranslationPrompt(id, lang as TargetLang);
    // Modyfikujemy prompt żeby zawierał TYLKO nie-cached (resztę pomijamy
    // bo i tak mamy w memory). Stary buildTranslationPrompt zawiera wszystkie
    // teksty — szybciej skleimy własny user prompt z subsetem.
    const userLines: string[] = [
      `Przetłumacz poniższe fragmenty z polskiego na ${lang.toUpperCase()}.`,
      "Każdy fragment to wartość JSON-owego klucza element_id - zachowaj ten klucz w odpowiedzi.",
      "",
      "Lista do przetłumaczenia:",
      "",
    ];
    for (const s of fromAi) {
      userLines.push(`element_id: ${s.id}`);
      userLines.push(`PL: ${JSON.stringify(s.text)}`);
      userLines.push("");
    }
    const translateMaxTokens = Math.min(16000, 200 + fromAi.length * 60);
    const translateUserPrompt = userLines.join("\n");
    const translateStartedAt = Date.now();
    const ai = await callClaude({
      system: built.system,
      user: translateUserPrompt,
      model: EDIT_MODEL,
      maxTokens: translateMaxTokens,
    });
    aiTranslations = parseTranslationResponse(ai.text);
    aiLog = {
      model: ai.model,
      input_tokens: ai.inputTokens,
      output_tokens: ai.outputTokens,
      latency_ms: ai.latencyMs,
    };

    // Pelna konwersacja AI — gen4_ai_calls.
    void logAiCall({
      project_id: id,
      endpoint: "translate",
      context_type: "project",
      user_instruction: `auto-translate ${fromAi.length} strings to ${lang.toUpperCase()}`,
      system_prompt: built.system,
      user_prompt: translateUserPrompt,
      model: ai.model,
      max_tokens: translateMaxTokens,
      response_text: ai.text,
      tokens_in: ai.inputTokens,
      tokens_out: ai.outputTokens,
      duration_ms: Date.now() - translateStartedAt,
      user_email: auth.email,
    });

    // Zapisz do memory + log.
    const memEntries: Array<{ source_text: string; target_text: string }> = [];
    for (const s of fromAi) {
      const t = aiTranslations.get(s.id);
      if (t && t.trim()) memEntries.push({ source_text: s.text, target_text: t });
    }
    void saveTranslations(auth.email, lang, memEntries);

    await sb.from("gen4_ai_history").insert({
      project_id: id,
      role: "assistant",
      content: `auto-translate to ${lang.toUpperCase()}: ${memEntries.length} freszy, ${memoryHits.size} z cache`,
      structured: {
        workflow_type: "translation",
        target_lang: lang,
        fresh_count: memEntries.length,
        cached_count: memoryHits.size,
      },
      ...aiLog,
    });
  }
  // Inkrement memory dla cache-hits.
  if (memoryHits.size > 0) {
    void incrementMemoryUseCount(
      auth.email,
      lang,
      sources.filter((s) => memoryHits.has(s.id)).map((s) => s.text),
    );
  }

  // 4. Upsert do gen4_translations (klucz unique element_id + language).
  const upsertRows: Array<{ element_id: string; project_id: string; language: string; text: string; source: string }> = [];
  for (const s of sources) {
    const text = memoryHits.get(s.id) ?? aiTranslations.get(s.id);
    if (text && text.trim()) {
      upsertRows.push({
        element_id: s.id,
        project_id: id,
        language: lang,
        text: text.trim(),
        source: memoryHits.has(s.id) ? "import" : "ai",
      });
    }
  }
  if (upsertRows.length > 0) {
    await sb
      .from("gen4_translations")
      .upsert(upsertRows, { onConflict: "element_id,language", ignoreDuplicates: false });
  }

  return NextResponse.json({
    ok: true,
    translations: upsertRows.length,
    cached: memoryHits.size,
    fresh: aiTranslations.size,
    total: sources.length,
  });
}
